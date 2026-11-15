// Namespace "actions" — Turkish. Must define exactly the keys of ../en/actions.ts with the same {placeholders}.
import type { actions as en } from "../en/actions";

export const actions: Record<keyof typeof en, string> = {
  "actions.title": "Ne Yapılmalı?",
  "actions.subtitle": "Etki × kapsam / efor ile önceliklendirilmiş aksiyonlar. Kod bloklarını kopyalayıp sitenize uygulayın, ardından yeniden kontrol edin.",
  "actions.recheckAll": "Tümünü Yeniden Kontrol Et",
  "actions.recheckRunning": "Kontrol sürüyor…",

  "actions.filter.status": "Durum",
  "actions.filter.priority": "Öncelik",
  "actions.filter.category": "Kategori",
  "actions.filter.all": "Tümü",
  "actions.filter.open": "Açık",
  "actions.filter.resolved": "Çözülen",
  "actions.filter.dismissed": "Yok sayılan",
  "actions.filter.allCategories": "Tüm kategoriler",
  "actions.filter.onlySnippets": "Sadece hazır kod bloğu olanlar",

  "actions.card.expectedGain": "≈ +{gain} GEO puanı",
  "actions.card.evidence": "Tespit",
  "actions.card.hideUrls": "Etkilenen sayfaları gizle",
  "actions.card.showUrls_one": "Etkilenen {count} sayfayı göster",
  "actions.card.showUrls_other": "Etkilenen {count} sayfayı göster",
  "actions.card.markResolved": "✓ Çözüldü Olarak İşaretle",
  "actions.card.markInProgress": "Üzerinde çalışıyorum",
  "actions.card.markOpen": "Açığa al",
  "actions.card.dismiss": "Yok say",
  "actions.card.recheck": "↻ Yeniden Kontrol Et",
  "actions.card.recheckHint": "Yeni analiz düzeltmeyi doğrular; sorun sürüyorsa aksiyon yeniden açılır.",
  "actions.card.reopen": "Tekrar aç",
  "actions.card.undo": "Geri al",
  "actions.card.resolvedOn": "Çözüldü: {date}",
  "actions.card.updatedOn": "Güncellendi: {date}",

  "actions.toast.resolved": "Çözüldü olarak işaretlendi. Doğrulamak için “Yeniden Kontrol Et” ile yeni analiz başlatın.",
  "actions.toast.inProgress": "Üzerinde çalışılıyor olarak işaretlendi.",
  "actions.toast.dismissed": "Aksiyon yok sayıldı; sonraki analizlerde yeniden oluşturulmayacak.",
  "actions.toast.reopened": "Aksiyon yeniden açıldı.",
  "actions.toast.updated": "Güncellendi.",

  "actions.empty.noOpen": "Açık aksiyon yok",
  "actions.empty.noOpenHint": "Tüm öneriler çözülmüş ya da henüz analiz yapılmamış. Yeni bir analiz ile siteyi yeniden kontrol edebilirsiniz.",
  "actions.empty.noMatch": "Bu filtreye uyan aksiyon yok",
  "actions.empty.noMatchHint": "Filtreleri değiştirmeyi deneyin.",
};
