// Namespace "auth" — Turkish.
import type { auth as en } from "../en/auth";

export const auth: Record<keyof typeof en, string> = {
  "auth.logout": "Çıkış",
  "auth.login.title": "Giriş",
  "auth.login.intro": "Bu panel korumalı. Devam etmek için sunucudaki {token} değerini girin.",
  "auth.login.tokenLabel": "Erişim anahtarı",
  "auth.login.submit": "Giriş yap",
  "auth.login.invalidToken": "Geçersiz erişim anahtarı.",
};
