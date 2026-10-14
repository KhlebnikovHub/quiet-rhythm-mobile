param(
    [string]$JavaHome,
    [string]$AndroidSdk,
    [switch]$SkipWebSync
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolingRoot = Join-Path $projectRoot 'artifacts\tooling'
$tempRoot = Join-Path $toolingRoot 'tmp'

if (-not $JavaHome) {
    $localJava = Get-ChildItem -LiteralPath $toolingRoot -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\java.exe') } |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($localJava) { $JavaHome = $localJava.FullName }
    elseif ($env:JAVA_HOME) { $JavaHome = $env:JAVA_HOME }
    else {
        $javaCommand = Get-Command java.exe -ErrorAction SilentlyContinue
        if ($javaCommand) { $JavaHome = Split-Path (Split-Path $javaCommand.Source -Parent) -Parent }
    }
}
$javaExecutable = if ($JavaHome) { Join-Path $JavaHome 'bin\java.exe' } else { '' }
if (-not $javaExecutable -or -not (Test-Path -LiteralPath $javaExecutable)) {
    throw 'JDK 21 is required. Set JAVA_HOME or pass -JavaHome with a JDK installation directory.'
}
$javaVersion = (& $javaExecutable --version | Out-String)
if ($LASTEXITCODE -ne 0 -or $javaVersion -notmatch '(?:openjdk|java) (\d+)') { throw 'Cannot determine the Java version.' }
$javaMajor = [int]$Matches[1]
if ($javaMajor -lt 21 -or $javaMajor -gt 24) { throw "This Gradle project needs JDK 21-24; detected JDK $javaMajor. JDK 21 is recommended." }

if (-not $AndroidSdk) {
    $sdkCandidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT)
    if ($env:LOCALAPPDATA) { $sdkCandidates += (Join-Path $env:LOCALAPPDATA 'Android\Sdk') }
    $sdkCandidates += 'C:\Android\sdk'
    $AndroidSdk = $sdkCandidates | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'platforms\android-36\android.jar')) } | Select-Object -First 1
}
if (-not $AndroidSdk -or -not (Test-Path -LiteralPath (Join-Path $AndroidSdk 'platforms\android-36\android.jar'))) {
    throw 'Android SDK Platform 36 is required. Set ANDROID_HOME or pass -AndroidSdk.'
}
$buildTools = Get-ChildItem -LiteralPath (Join-Path $AndroidSdk 'build-tools') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' -and [version]$_.Name -ge [version]'35.0.0' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'aapt2.exe')) } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $buildTools) { throw 'Install Android SDK Build-Tools 35.0.0 or newer before building.' }

$savedEnvironment = @{}
foreach ($name in @('JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_USER_HOME','ANDROID_SDK_HOME','GRADLE_USER_HOME','TEMP','TMP','DEBUG')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $env:JAVA_HOME = [IO.Path]::GetFullPath($JavaHome)
    $env:ANDROID_HOME = [IO.Path]::GetFullPath($AndroidSdk)
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    # New and legacy Android tools must resolve to the same .android directory.
    $env:ANDROID_USER_HOME = Join-Path $toolingRoot '.android'
    $env:ANDROID_SDK_HOME = $toolingRoot
    New-Item -ItemType Directory -Path $env:ANDROID_USER_HOME -Force | Out-Null
    $env:GRADLE_USER_HOME = Join-Path $toolingRoot 'gradle-home'
    $env:TEMP = $tempRoot
    $env:TMP = $tempRoot
    $env:DEBUG = ''

    if (-not $SkipWebSync) {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw 'Node.js 22 or newer is required.' }
        $capacitorCli = Join-Path $projectRoot 'node_modules\@capacitor\cli\bin\capacitor'
        if (-not (Test-Path -LiteralPath $capacitorCli)) { throw 'Run npm ci in the mobile directory first.' }
        Push-Location -LiteralPath $projectRoot
        try {
            & $nodeCommand.Source (Join-Path $PSScriptRoot 'build-native.mjs')
            if ($LASTEXITCODE -ne 0) { throw 'Bundling the offline web application failed.' }
            & $nodeCommand.Source $capacitorCli sync android
            if ($LASTEXITCODE -ne 0) { throw 'Capacitor Android sync failed.' }
        } finally { Pop-Location }
    }

    $androidRoot = Join-Path $projectRoot 'android'
    if (-not (Test-Path -LiteralPath (Join-Path $androidRoot 'capacitor.settings.gradle'))) { throw 'Run npm run sync:native before using -SkipWebSync.' }
    # Configure every Android module, including plugins, to use an installed
    # Build-Tools package rather than automatically installing a default one.
    $initScript = Join-Path $toolingRoot 'android-build-tools.init.gradle'
    $initContent = @'
allprojects { project ->
    ['com.android.application', 'com.android.library'].each { pluginId ->
        project.plugins.withId(pluginId) {
            project.android.buildToolsVersion = '__BUILD_TOOLS__'
        }
    }
}
'@
    Set-Content -LiteralPath $initScript -Value $initContent.Replace('__BUILD_TOOLS__', $buildTools.Name) -Encoding ascii
    $gradleCommand = Join-Path $toolingRoot 'gradle-8.14.3\bin\gradle.bat'
    if (-not (Test-Path -LiteralPath $gradleCommand)) { $gradleCommand = Join-Path $androidRoot 'gradlew.bat' }
    Write-Host "Building with JDK $javaMajor, SDK 36, Build-Tools $($buildTools.Name)..."
    & $gradleCommand --no-daemon --console=plain --max-workers=2 '-Pkotlin.compiler.execution.strategy=in-process' -I $initScript -p $androidRoot :app:assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed. See the Gradle output above.' }

    $apk = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path -LiteralPath $apk)) { throw 'Gradle completed without producing the expected APK.' }
    $releaseDirectory = Join-Path $projectRoot 'releases'
    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    $releaseApk = Join-Path $releaseDirectory 'quiet-rhythm-android.apk'
    Copy-Item -LiteralPath $apk -Destination $releaseApk -Force
    Write-Host "Android test APK: $releaseApk"
    Write-Host 'This is a debug-signed APK for direct installation; store releases need a private release signing key.'
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
