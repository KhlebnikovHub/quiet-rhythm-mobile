#!/usr/bin/env python3
"""Create the small, portable iOS source upload. Python 3.10+, no dependencies.

Run from any directory: python scripts/package-codemagic.py
--check validates without writing. Existing outputs are never replaced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import sys
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zipfile


FILES = (
    '.gitignore', 'README.md', 'package.json', 'package-lock.json',
    'capacitor.config.json', 'codemagic.yaml', 'run.bat',
    'index.html', 'styles.css', 'app.js', 'core.js', 'sample-tabs.js',
    'playback.js', 'export.js', 'storage.js', 'sw.js', 'manifest.webmanifest',
    'app-icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
    'scripts/serve.mjs', 'scripts/build.mjs', 'scripts/build-native.mjs',
    'scripts/build-android.ps1', 'scripts/build-ios-unsigned.sh',
    'scripts/package-codemagic.py',
    'native/bridge.js', 'native/android/ExportFilePlugin.java',
    'native/ios/ExportFilePlugin.swift', 'native/IOS-INSTALL.md',
    'native/CODEMAGIC-WINDOWS.md',
    'ios/.gitignore', 'ios/debug.xcconfig',
    'ios/App/CapApp-SPM/.gitignore', 'ios/App/CapApp-SPM/README.md',
    'ios/App/CapApp-SPM/Package.swift',
    'ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift',
    'ios/App/App.xcodeproj/project.pbxproj',
    'ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme',
    'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/IDEWorkspaceChecks.plist',
    'ios/App/App/AppDelegate.swift', 'ios/App/App/SceneDelegate.swift',
    'ios/App/App/BridgeViewController.swift', 'ios/App/App/ExportFilePlugin.swift',
    'ios/App/App/Info.plist', 'ios/App/App/PrivacyInfo.xcprivacy',
    'ios/App/App/Base.lproj/Main.storyboard',
    'ios/App/App/Base.lproj/LaunchScreen.storyboard',
    'ios/App/App/Assets.xcassets/Contents.json',
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json',
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
    'ios/App/App/Assets.xcassets/Splash.imageset/Contents.json',
    'ios/App/App/Assets.xcassets/Splash.imageset/splash.png',
    'tests/browser_cdp.py', 'tests/browser_smoke.py', 'tests/browser_native_ui.py',
    'tests/export.test.cjs', 'tests/native-bridge.test.cjs', 'tests/storage.test.cjs',
)
GENERATOR = 'quiet-rhythm-codemagic-source-v1'
FOLDER = 'releases/codemagic-upload'
ARCHIVE = 'releases/quiet-rhythm-codemagic-source.zip'
SIDECAR = ARCHIVE + '.sha256'
REPORT = 'artifacts/codemagic-source-manifest.json'
EXCLUDED_PARTS = {
    '.git', '.openai', '.aws', 'node_modules', 'artifacts', 'releases',
    'native-dist', 'dist', 'public', '__pycache__', 'xcuserdata', '.build',
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def relative_name(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    require(bool(name) and not path.is_absolute() and '\\' not in name
            and ':' not in name and '..' not in path.parts
            and path.as_posix() == name, f'Unsafe relative path: {name!r}')
    return path


def checked_path(root: Path, name: str) -> Path:
    """Reject symlinks and Windows junctions in any existing component."""
    parts = relative_name(name).parts
    current = root
    for part in parts:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode)
                and not getattr(info, 'st_file_attributes', 0)
                & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024),
                f'Links are not allowed: {name}')
    require(current.resolve().is_relative_to(root), f'Path leaves source root: {name}')
    return current


def portable_document(data: bytes, root: Path) -> bytes:
    """Keep local instructions useful without publishing the author's path."""
    text = data.decode('utf-8')
    for base in (str(root), root.as_posix()):
        for separator in ('\\', '/'):
            text = text.replace(base + separator, '')
    for base in (str(root.parent), root.parent.as_posix()):
        text = text.replace(base, 'исходный проект')
    return text.encode('utf-8')


def read_sources(root: Path) -> tuple[dict[str, bytes], list[str]]:
    require(len(FILES) < 100, 'GitHub browser upload must contain fewer than 100 files.')
    require(len({name.casefold() for name in FILES}) == len(FILES), 'Duplicate paths.')
    payload: dict[str, bytes] = {}
    normalized = []
    for name in sorted(FILES):
        parts = relative_name(name).parts
        require(not EXCLUDED_PARTS.intersection(parts), f'Excluded content: {name}')
        require(parts[0] != 'android', 'The Android project must not be packaged.')
        path = checked_path(root, name)
        require(path.is_file(), f'Required source is missing: {name}')
        data = path.read_bytes()
        require(len(data) <= 5 * 1024 * 1024, f'Source unexpectedly large: {name}')
        original = data
        if name.endswith('.sh'):
            data = data.decode('utf-8').replace('\r\n', '\n').replace('\r', '\n').encode('utf-8')
        if name.endswith('.md'):
            data = portable_document(data, root)
        if data != original:
            normalized.append(name)
        payload[name] = data
    require(sum(map(len, payload.values())) < 10 * 1024 * 1024, 'Source package exceeds 10 MiB.')
    return payload, normalized


def validate(payload: dict[str, bytes]) -> dict:
    require(set(payload) == set(FILES), 'Package does not match the explicit source whitelist.')
    texts = {}
    for name, data in payload.items():
        if name.endswith('.png'):
            require(data.startswith(b'\x89PNG\r\n\x1a\n'), f'Invalid PNG: {name}')
            continue
        text = data.decode('utf-8')
        require('\x00' not in text and '\ufffd' not in text, f'Invalid text encoding: {name}')
        require(not re.search(r'[A-Za-z]:[\\/]+(?:Users|Documents and Settings|progy)[\\/]', text, re.I)
                and not re.search(r'/(?:Users|home)/[\w.-]+/', text), f'Private local path: {name}')
        require(not re.search(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', text)
                and not re.search(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b', text)
                and not re.search(r'https?://[^\s/@:]+:[^\s/@]+@', text), f'Possible credential: {name}')
        texts[name] = text
        if name.endswith('.sh'):
            require(text.startswith('#!/usr/bin/env bash\n') and '\r' not in text,
                    f'Shell scripts must use a Bash shebang and LF: {name}')

    objects = {name: json.loads(text) for name, text in texts.items()
               if name.endswith(('.json', '.webmanifest'))}
    package = objects['package.json']
    lock = objects['package-lock.json']
    require(lock.get('lockfileVersion') == 3, 'Expected npm lockfile version 3.')
    locked_root = lock['packages']['']
    for field in ('name', 'version', 'dependencies', 'devDependencies', 'engines'):
        require(package.get(field) == locked_root.get(field), f'package-lock mismatch: {field}')
    versions = {**package.get('dependencies', {}), **package.get('devDependencies', {})}
    for name, version in versions.items():
        require(re.fullmatch(r'\d+\.\d+\.\d+', version) is not None,
                f'Direct dependency must be pinned: {name}')
        require(lock['packages']['node_modules/' + name]['version'] == version,
                f'Locked dependency mismatch: {name}')
    for name, entry in lock['packages'].items():
        if name:
            url = urlsplit(entry.get('resolved', ''))
            require(url.scheme == 'https' and url.hostname == 'registry.npmjs.org'
                    and url.username is None and url.password is None,
                    f'Unexpected npm dependency source: {name}')

    config = objects['capacitor.config.json']
    require(config.get('webDir') == 'native-dist', 'Unexpected Capacitor webDir.')
    require(not config.get('server', {}).get('url')
            and not config.get('server', {}).get('allowNavigation'), 'App must use bundled assets.')
    require('bash scripts/build-ios-unsigned.sh' in texts['codemagic.yaml'], 'Missing Codemagic build entry.')
    build_script = texts['scripts/build-ios-unsigned.sh']
    for command in ('npm ci', 'npm run build:native', 'cap sync ios', 'CODE_SIGNING_ALLOWED=NO'):
        require(command in build_script, f'iOS build step missing: {command}')
    for command in package.get('scripts', {}).values():
        for script in re.findall(r'scripts/[\w.-]+\.(?:mjs|py|sh|ps1)', command):
            require(script in payload, f'npm script source missing: {script}')

    # Check every static source read by the native bundle and each plugin template.
    native_build = texts['scripts/build-native.mjs']
    file_array = re.search(r'const files\s*=\s*\[(.*?)\];', native_build, re.S)
    require(file_array is not None, 'Could not validate native asset list.')
    for name in re.findall(r"['\"]([^'\"]+)['\"]", file_array.group(1)):
        require(name in payload, f'Native asset missing: {name}')
    for name in re.findall(r"['\"](native/[^'\"]+)['\"]", native_build):
        require(name in payload, f'Native template missing: {name}')
    require(payload['native/ios/ExportFilePlugin.swift'] == payload['ios/App/App/ExportFilePlugin.swift'],
            'iOS export plugin differs from its canonical template.')
    for name in re.findall(r'(?:src|href)="([^"#]+)"', texts['index.html']):
        require(name == './' or name in payload, f'HTML asset missing or remote: {name}')
    for name, value in objects.items():
        if name.endswith('/Contents.json'):
            for item in value.get('images', []):
                if item.get('filename'):
                    asset = (PurePosixPath(name).parent / item['filename']).as_posix()
                    require(asset in payload, f'Xcode image asset missing: {asset}')

    for name, data in payload.items():
        if name.endswith(('.plist', '.xcprivacy')):
            plistlib.loads(data)
        elif name.endswith(('.storyboard', '.xcscheme')):
            ET.fromstring(data)
    scheme = ET.fromstring(payload['ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme'])
    require(scheme.find('.//ArchiveAction') is not None, 'Shared Xcode archive scheme is missing.')
    for reference in scheme.findall('.//BuildableReference'):
        require(reference.get('ReferencedContainer') == 'container:App.xcodeproj'
                and reference.get('BuildableName') == 'App.app', 'Unexpected Xcode scheme reference.')
    swift_package = texts['ios/App/CapApp-SPM/Package.swift']
    require(f'exact: "{versions["@capacitor/ios"]}"' in swift_package, 'SPM Capacitor version mismatch.')
    for name in re.findall(r'path: "\.\./\.\./\.\./node_modules/([^"\n]+)"', swift_package):
        require(name in versions, f'SPM local dependency absent from npm: {name}')
    project = texts['ios/App/App.xcodeproj/project.pbxproj']
    for source in ('BridgeViewController.swift', 'ExportFilePlugin.swift', 'SceneDelegate.swift', 'AppDelegate.swift'):
        require(f'{source} in Sources' in project, f'iOS source not in target: {source}')

    return {
        'explicit_whitelist': True, 'root_codemagic_yaml': True, 'under_100_files': True,
        'utf8_text': True, 'shell_scripts_lf': True, 'package_lock_matches': True,
        'native_assets_and_templates_present': True, 'ios_scheme_and_asset_references': True,
        'generated_data_and_credentials_excluded': True,
        'direct_dependency_versions': versions,
        'ios_compilation_performed': False,
    }


def package_sources(root: Path, payload: dict[str, bytes], normalized: list[str],
                    checks: dict) -> dict:
    for name in (FOLDER, ARCHIVE, SIDECAR, REPORT):
        require(not checked_path(root, name).exists(), f'Output already exists; refusing to replace: {name}')
    for name in ('releases', 'artifacts'):
        checked_path(root, name).mkdir(exist_ok=True)
    checked_path(root, FOLDER).mkdir()
    with zipfile.ZipFile(checked_path(root, ARCHIVE), 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(payload.items()):
            destination = checked_path(root, FOLDER + '/' + name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as stream:
                stream.write(data)
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if name.endswith('.sh') else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data, compresslevel=9)
    with zipfile.ZipFile(checked_path(root, ARCHIVE)) as archive:
        require(archive.testzip() is None, 'ZIP integrity check failed.')
        require(archive.namelist() == sorted(payload), 'ZIP content differs from whitelist.')
        for name, data in payload.items():
            require(archive.read(name) == data, f'ZIP bytes differ: {name}')
            require(checked_path(root, FOLDER + '/' + name).read_bytes() == data,
                    f'Upload folder bytes differ: {name}')
    zip_data = checked_path(root, ARCHIVE).read_bytes()
    result = {
        'generator': GENERATOR, 'file_count': len(payload),
        'source_bytes': sum(map(len, payload.values())),
        'archive': {'path': ARCHIVE, 'bytes': len(zip_data), 'sha256': digest(zip_data)},
        'normalizations': normalized, 'validation': {**checks, 'zip_crc_and_all_file_bytes': True},
        'files': [{'path': name, 'bytes': len(data), 'sha256': digest(data)}
                  for name, data in sorted(payload.items())],
    }
    with checked_path(root, SIDECAR).open('x', encoding='ascii', newline='\n') as stream:
        stream.write(f'{result["archive"]["sha256"]}  {PurePosixPath(ARCHIVE).name}\n')
    with checked_path(root, REPORT).open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate sources without writing outputs.')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    payload, normalized = read_sources(root)
    checks = validate(payload)
    if args.check:
        print(json.dumps({'valid': True, 'files': len(payload),
                          'source_bytes': sum(map(len, payload.values())),
                          'normalizations': normalized, 'checks': checks}, ensure_ascii=False, indent=2))
        return
    result = package_sources(root, payload, normalized, checks)
    print(json.dumps({key: result[key] for key in ('file_count', 'source_bytes', 'archive', 'normalizations')},
                     ensure_ascii=False, indent=2))
    print(f'Upload the CONTENTS of {FOLDER}/, not the ZIP or its enclosing directory.')
    print(f'Validation manifest: {REPORT}')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f'Packaging stopped: {error}', file=sys.stderr)
        sys.exit(1)
