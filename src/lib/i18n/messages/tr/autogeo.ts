// Namespace "autogeo" — Turkish. Must define exactly the keys of ../en/autogeo.ts with the same {placeholders}.
import type { autogeo as en } from "../en/autogeo";

export const autogeo: Record<keyof typeof en, string> = {
  // ------------------------------------------------------------ metrics: label + how to apply the suggested patch
  "autogeo.metric.statistics.label": "İstatistik ve sayısal veri",
  "autogeo.metric.statistics.instructions": "Köşeli parantezli [SAYI]/[%ORAN] alanlarını doğrulanmış rakamlarla ve kaynağıyla doldurun.",
  "autogeo.metric.quotations.label": "Uzman alıntısı",
  "autogeo.metric.quotations.instructions": "Gerçek, izinli ve unvanlı bir uzmandan doğrudan alıntı kullanın; ad, unvan ve kurumu yazın.",
  "autogeo.metric.citations.label": "Yetkili kaynak gösterimi",
  "autogeo.metric.citations.instructions": "Yer tutucu bağlantıları .gov/.edu, DOI veya tanınmış sektör raporlarının adresleriyle değiştirin.",
  "autogeo.metric.answer_capsules.label": "Yanıt kapsülü (40-60 kelime)",
  "autogeo.metric.answer_capsules.instructions": "Paragrafı başlığın hemen altına yerleştirin; 40-60 kelime ve kendi başına anlaşılır kalsın.",
  "autogeo.metric.authority_fluency.label": "Otoriter ton ve akıcılık",
  "autogeo.metric.authority_fluency.instructions": "Önerilen metni yayına almadan önce anlamın korunduğunu kontrol edin.",
  "autogeo.metric.keyword_stuffing.label": "Anahtar kelime doldurma",
  "autogeo.metric.keyword_stuffing.instructions": "[eş anlamlı/zamir] yer tutucularını doğal eş anlamlılar veya zamirlerle değiştirin.",

  // ------------------------------------------------------------ ActionItem title / description
  "autogeo.item.title_one": "{label}: {count} iyileştirme — /{path}",
  "autogeo.item.title_other": "{label}: {count} iyileştirme — /{path}",
  "autogeo.item.titleWeak": "{label} zayıf — /{path}",
  "autogeo.item.titleComparison": "Karşılaştırma tablosu ekleyin — /{path}",
  "autogeo.item.description.score": "{label} skoru {score}/100. {detail}",
  "autogeo.item.description.gain": "Tahmini görünürlük kazancı: +%{gain}.",
  "autogeo.item.description.others": "Bu yamalar ayrıca şunları da iyileştirir: {labels}.",

  // ------------------------------------------------------------ "Apply to CMS" webhook delivery
  "autogeo.cms.delivered": "Teslim edildi",
};
