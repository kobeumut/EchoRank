// Namespace "labels" — Turkish.
import type { labels as en } from "../en/labels";

export const labels: Record<keyof typeof en, string> = {
  "labels.score.good": "İyi",
  "labels.score.warning": "Orta",
  "labels.score.serious": "Zayıf",
  "labels.score.critical": "Kritik",
  "labels.score.neutral": "Veri yok",

  "labels.model.chatgpt": "ChatGPT",
  "labels.model.gemini": "Gemini",
  "labels.model.claude": "Claude",
  "labels.model.perplexity": "Perplexity",
  "labels.model.copilot": "Copilot",
  "labels.model.other": "Diğer",

  "labels.citation.cited": "Atıf (kaynak)",
  "labels.citation.mentioned": "Bahsedildi",
  "labels.citation.none": "Yer almadı",

  "labels.tier.high": "Kritik",
  "labels.tier.medium": "Önemli",
  "labels.tier.low": "İyileştirme",

  "labels.category.crawler": "AI Bot Erişimi",
  "labels.category.schema": "Yapısal Veri",
  "labels.category.content": "İçerik",
  "labels.category.authority": "Otorite / E-E-A-T",
  "labels.category.technical": "Teknik",

  "labels.effort.high": "Yüksek efor",
  "labels.effort.medium": "Orta efor",
  "labels.effort.low": "Düşük efor",

  "labels.actionStatus.open": "Açık",
  "labels.actionStatus.in_progress": "Üzerinde çalışılıyor",
  "labels.actionStatus.resolved": "Çözüldü",
  "labels.actionStatus.dismissed": "Yok sayıldı",

  "labels.entity.Page": "Sayfa",
  "labels.entity.Product": "Ürün",
  "labels.entity.Category": "Kategori",
  "labels.entity.FAQ": "SSS",
  "labels.entity.Question": "SSS",
  "labels.entity.Organization": "Kurum",
  "labels.entity.Author": "Yazar",
  "labels.entity.Person": "Yazar",
  "labels.entity.Brand": "Marka",
  "labels.entity.Article": "Makale",
  "labels.entity.Concept": "Kavram",
  "labels.entity.Offer": "Teklif",
  "labels.entity.WebSite": "Web sitesi",

  "labels.platform.indexnow": "IndexNow",
  "labels.platform.google_indexing": "Google Indexing API",
  "labels.platform.google_search_console": "Search Console",
  "labels.platform.webhook": "Webhook",

  "labels.time.justNow": "az önce",
  "labels.time.minutesAgo_one": "{count} dk önce",
  "labels.time.minutesAgo_other": "{count} dk önce",
  "labels.time.hoursAgo_one": "{count} saat önce",
  "labels.time.hoursAgo_other": "{count} saat önce",
  "labels.time.daysAgo_one": "{count} gün önce",
  "labels.time.daysAgo_other": "{count} gün önce",
  "labels.time.monthsAgo_one": "{count} ay önce",
  "labels.time.monthsAgo_other": "{count} ay önce",
  "labels.time.yearsAgo_one": "{count} yıl önce",
  "labels.time.yearsAgo_other": "{count} yıl önce",
};
