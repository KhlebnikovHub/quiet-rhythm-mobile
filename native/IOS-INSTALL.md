# Установка на iPhone и iPad

В `ios/App/App.xcodeproj` подготовлен нативный проект «Тихий ритм» для iOS 15.4 и новее. Интерфейс, редактор, примеры, звук и экспорт упаковываются внутрь приложения. После установки приложение не обращается к нашему сайту: сервер, учётная запись приложения и интернет для редактирования не нужны. PNG и JSON можно сохранить в «На моём iPhone» через системное окно «Файлы»; выбор iCloud или другого сетевого провайдера требует сети.

Минимальная версия приложения — iOS/iPadOS 15.4: редактор использует `dialog.showModal()` и `Array.at()`, которые появились в этой версии WebKit. [WebKit: Safari 15.4](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/).

**Подписанный установочный IPA пока не собран.** На Windows нельзя запустить Xcode локально, но собственный Mac не обязателен: подготовлен сценарий [Codemagic → IPA → Sideloadly на Windows](CODEMAGIC-WINDOWS.md). Облачная сборка ещё не запускалась. Ниже описан альтернативный путь для владельцев Mac с Xcode 26 или новее и Apple Account для подписи. Используется Swift Package Manager; CocoaPods этому проекту не требуется. Требования среды: [Capacitor iOS](https://capacitorjs.com/docs/ios).

## Подготовка на Mac

Скопируйте папку `mobile` целиком, включая `ios`, `native`, `scripts` и `package-lock.json`. Папки `node_modules` и `artifacts` переносить не нужно. Установите Node.js 22 или новее, Xcode и платформу iOS в настройках Xcode.

В терминале из `mobile`:

```sh
npm ci
npm run build:native
npx cap sync ios
open ios/App/App.xcodeproj
```

Не запускайте `cap add ios` повторно: проект уже содержит собственный мост экспорта, экран запуска, иконку и privacy manifest. `cap sync` обновляет локальные ресурсы приложения и Swift Package Manager зависимости. В `capacitor.config.json` не должно быть `server.url`: приложение загружает встроенные файлы.

## Проверка на своём телефоне

1. В Xcode откройте target **App → Signing & Capabilities**. Включите **Automatically manage signing** и выберите свой **Team**. Если идентификатор `com.hangcreator.mobile` занят, задайте собственный уникальный Bundle Identifier.
2. Подключите iPhone к Mac, подтвердите доверие и при запросе включите Developer Mode. Выберите этот телефон как устройство запуска и нажмите **Run**.
3. После первого запуска включите авиарежим. Создайте табулатуру, измените ноты, закройте приложение и откройте снова. Проверьте воспроизведение, экспорт PNG и резервной копии JSON в локальные «Файлы», затем импорт JSON обратно.

Бесплатный **Personal Team** подходит для разработки: профиль подписи действует 7 дней, после этого приложение нужно пересобрать и установить снова. Это ограничение Apple, а не срок хранения табулатур. [Apple: Personal Team](https://developer.apple.com/help/account/basics/about-your-developer-account).

Проверка компиляции для симулятора без подписи:

```sh
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath artifacts/ios-simulator \
  CODE_SIGNING_ALLOWED=NO build
```

## Как передавать приложение другим людям

- **App Store** — обычная установка на телефон без срока действия тестовой сборки. Нужны Apple Developer Program, подпись, запись приложения в App Store Connect и проверка Apple.
- **TestFlight** — удобная установка пробной версии по приглашению; каждая сборка доступна до 90 дней. Нужен Apple Developer Program; внешнее тестирование может потребовать проверки. [Apple: TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).
- **Ad Hoc IPA** — установка на заранее зарегистрированные устройства. Нужны сертификат, соответствующий provisioning profile и список устройств. Произвольный скачанный IPA не устанавливается на любой iPhone. [Apple: registered devices](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices).

Для выпуска выберите в Xcode **Any iOS Device → Product → Archive → Distribute App**, затем нужный способ. Сертификаты и Team не записаны в репозиторий: их выбирает владелец Apple Account. Проект ничего не публикует автоматически. Установка и проверка подписи могут потребовать интернет; офлайн работает уже установленное и разрешённое системой приложение.

## Что уже настроено

- Русское название, светлый интерфейс, портретная и горизонтальная ориентации, iPhone и iPad.
- Иконка 1024×1024 и экран запуска с цветами приложения.
- `BridgeViewController` регистрирует `ExportFilePlugin`; экспорт открывает системный выбор места сохранения.
- Поддержка «Файлов» в `Info.plist`. Разрешение на фотогалерею не запрашивается: картинки сохраняются в выбранную папку или передаются через «Поделиться».
- `PrivacyInfo.xcprivacy` декларирует файловые временные метки с причиной `C617.1` для локальной работы Filesystem, без сбора данных и трекинга. [Capacitor Filesystem](https://capacitorjs.com/docs/apis/filesystem).

В этой Windows-среде проверена структура проекта и ресурсов. Компиляция Swift/Xcode, фактическая установка, «Файлы» и воспроизведение на iPhone ещё требуют проверки на Mac и устройстве.
