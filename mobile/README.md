# Al syed Initiative Android App

Native React Native/Expo client for the existing Al syed Initiative Django API.

## Local development

1. Copy `.env.example` to `.env.local` if you need a different API host.
2. Run `npm install`.
3. Run `npm run android` with an Android emulator or connected device.

The production API defaults to `https://api.alsyedinitiative.com/api`.

## Validation

```powershell
npm run validate
```

## Authentication

The app uses `/api/auth/mobile/login/`, `/api/auth/mobile/refresh/`, and
`/api/auth/mobile/logout/`. Refresh tokens are stored with Expo SecureStore;
protected requests use the existing Django bearer-token authentication path.
