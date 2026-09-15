// C5. Earned-media helper (deterministik, tanpa dependensi eksternal).
// Eksekusi manual via endpoint; template untuk deskripsi YouTube + profil NAP.
export const NAP = {
  name: 'Beriklan Digital Agency',
  address: 'Jl. Arcamanik Endah No.76, Bandung 40195, Indonesia',
  phone: '+62 811-919-328',
  email: 'info@beriklan.co.id',
  site_id: 'https://beriklan.co.id/',
  site_my: 'https://beriklan.my/',
  hours: 'Senin–Jumat 09:00–17:00 WIB',
};

export function youtubeDescription({ topic, url, lang = 'id' }) {
  const t = (topic || 'digital marketing').slice(0, 120);
  const u = (url || NAP.site_id).slice(0, 200);
  if (lang === 'ms') {
    return [`${t} — panduan praktikal untuk pemilik bisnes di Malaysia.`,
      ``,
      `Baca panduan penuh: ${u}`,
      ``,
      `Konsultasi percuma 30 minit: https://wa.me/62811919328`,
      `Agensi: ${NAP.name} — kempen iklan sejak 2016 (Meta, Google, TikTok, YouTube).`,
      ``,
      `#digitalmarketingmalaysia #iklanonline #usahawan`.slice(0, 400)].join('\n');
  }
  return [`${t} — panduan praktis untuk UMKM & bisnis Indonesia.`,
    ``,
    `Baca panduan lengkap: ${u}`,
    ``,
    `Konsultasi gratis 30 menit: https://wa.me/62811919328`,
    `Agency: ${NAP.name} — mengelola campaign iklan sejak 2016 (Meta, Google, TikTok, YouTube).`,
    ``,
    `#digitalmarketing #iklanonline #umkm`.slice(0, 400)].join('\n');
}

export function directoryProfile() {
  return {
    ...NAP,
    categories_id: ['Agen Periklanan', 'Konsultan Pemasaran Digital', 'Jasa Iklan Online'],
    categories_en: ['Advertising Agency', 'Digital Marketing Consultant', 'Online Advertising Service'],
    note_id: 'Gunakan NAMA + ALAMAT + TELEPON persis seperti di atas di semua direktori (Google Business, Bing Places, Yelp, direktori lokal) — konsistensi NAP adalah sinyal authority.',
  };
}
