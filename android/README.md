# Android-клиент руководителя TAMEER HR

Клиент открывает мобильный кабинет `/manager` на HTTPS-сервере, указанном при сборке. Для входа используются учётная запись TAMEER HR и права руководителя.

## Сборка

Нужны Python 3, JDK 21 и Android SDK с платформой Android 36 и Build Tools 36.0.0. Минимальная версия для установки — Android 8.0.

Запустите из этой папки. Замените домен и пути своими значениями.

```text
python build.py --host hr.example.com --sdk /path/to/android-sdk --jdk /path/to/jdk --keystore /private/tameer-hr.p12 --password-file /private/tameer-hr.password --out build/TAMEER-HR-manager.apk --work build/work
```

Для первой сборки добавьте `--create-key`. Храните ключ подписи и файл с паролем отдельно от репозитория. Для обновлений уже установленных приложений используйте тот же ключ. Параметр `--node` добавляет проверки кнопки «Назад», если указан путь к Node.js.

Сборка проверяет подпись, выравнивание APK и ограничения WebView. Отчёт сохраняется в `build/work/BUILD-VERIFICATION.json`.

## Раздача обновлений

Для собственного сервера используйте манифест `TAMEER-HR-manager.update.json`, созданный вместе с APK. Клиент загружает манифест и APK с того же HTTPS-домена и проверяет совпадение сертификата подписи с установленной сборкой. Поместите манифест в `public/downloads/android-update.json`, а APK в `public/downloads/TAMEER-HR-manager.apk`. Задайте `ANDROID_SIGNER_SHA256` из поля `signerSha256` манифеста и HTTPS-адрес в `PUBLIC_URL`. Для Docker подключите каталог `./public/downloads` в контейнер как `/app/public/downloads` в режиме чтения.
