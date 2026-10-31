# Celengin

Project buat nyatet duit kalian. Duit masuk, keluar, pindah dompet, budget, sama target nabung bisa diliat di satu tempat. Pake aja kalo mau wkwk.

## Privacy first

Data duit kalian disimpen di device sendiri, pake database SQLite. Database nggak diupload ke server gue, dan nggak perlu bikin akun Celengin. Data, konfigurasi akun, sama backup kalian pegang sendiri.

Dashboard jalan lewat server lokal di device kalian, tanpa server pusat buat nyimpen data keuangan. Buat nyatet manual, nggak perlu internet.

Kalo pake sync Gmail atau harga aset, apps bakal hubungin Gmail, CoinGecko, Indodax, atau Pasardana sesuai fitur yang dipake. Email diproses di device kalian. Request harga aset nggak ngirim saldo atau jumlah aset yang kalian punya. Login Gmail (App Password) disimpen di database lokal, jadi database sama backup-nya simpen buat sendiri aja.

## Bisa ngapain aja?

- Bikin dompet dan atur saldo.
- Nyatet duit masuk, keluar, sama transfer antar dompet.
- Liat rekap transaksi bulanan.
- Atur rencana pemasukan, pengeluaran, sama budget per kategori.
- Bikin jadwal transaksi rutin dan target nabung.
- Atur tanggal gajian per bulan. Gaji maju ke tanggal 31? Bulan berikutnya mulai dari tanggal itu.
- Baca beberapa format notif transaksi dari Gmail. Daftarnya ada di bawah.
- Ngitung nilai crypto dan reksa dana dari harga/NAB terbaru yang berhasil diambil.
- Ganti tema terang/gelap atau umpetin saldo.
- Backup database otomatis tiap hari (nyimpen 14 terakhir), plus download backup, restore, sama export transaksi ke CSV dari menu **Pengaturan**.
- Kunci pakai PIN pas apps dibuka.
- Streak nyatet harian biar tetep semangat.
- Dikasih tau kalo ada versi baru.

## Aset apa aja?

| Jenis | Yang tersedia | Ngitung saldonya |
| --- | --- | --- |
| Dompet manual | Cash, rekening bank, e-wallet, deposito, atau aset lain yang kalian catet sendiri | Isi saldo Rupiah, nanti berubah ngikutin transaksi |
| Crypto | Bitcoin (BTC), Ethereum (ETH), Solana (SOL), BNB (BNB), XRP (XRP), Dogecoin (DOGE), Tether (USDT) | Jumlah koin × harga Rupiah |
| Reksa dana | Pasar Uang (RDPU), Pendapatan Tetap, Saham, Campuran, dan Terproteksi | Jumlah unit × NAB per unit produk yang dipilih |

Harga crypto dari CoinGecko. Kalo gagal, apps coba ambil dari Indodax. Dicek tiap 5 menit; perubahan harga 24 jam ditampilin kalo datanya tersedia.

Reksa dana dicari lewat nama produk di data Pasardana. Jadi produknya ngikutin hasil dari Pasardana yang punya NAB positif, bukan daftar nama yang gue masukin satu-satu. Info produknya mencakup manajer investasi, jenis, status syariah, NAB, sama tanggal NAB. Apps ngecek tiap 5 menit, tapi NAB tetap ngikutin tanggal data Pasardana, bukan berubah tiap menit.

Cara pakenya: buka **Atur harga live** di dompet, pilih **Crypto** atau **Reksa dana**, pilih asetnya, terus isi jumlah koin/unit atau nilai Rupiah. Kalo isi Rupiah, nilainya dikonversi jadi unit pake harga pas disimpen. Setelah itu saldo ngikutin jumlah unit tadi.

Kalo internet atau sumber harga gagal, saldo pake nilai terakhir yang berhasil diambil. Saham individual, ETF, emas, sama kurs valas belum punya harga otomatis; masih bisa dicatet manual. Apps ini buat nyatet aset dan nilainya, bukan buat beli/jual aset.

## Install di Windows

Download `Celengin-Setup-<versi>-x64.exe` versi terbaru dari [Releases](https://github.com/ibrahimhaykal/celengin/releases), jalanin installer, terus buka dari shortcut. Nggak perlu install Node.js buat versi ini.

Pas pertama dibuka, ada 3 langkah singkat: bikin wallet pertama, pilih budget bulanan dari template, terus (opsional) hubungin Gmail.

## Mulai pakenya gimana?

1. Tambah dompet, isi saldo awal.
2. Atur rencana pemasukan, pengeluaran, sama budget kategori.
3. Catet transaksi dan pilih dompet yang dipake.
4. Tambah jadwal rutin atau target nabung kalo perlu.
5. Liat saldo, sisa budget, sama rekap bulanan dari dashboard.

Tutup jendela cuma bikin apps masuk ke tray, masih jalan di background. Kalo mau berhenti total, pilih **Keluar** dari menu tray. Di situ juga ada opsi buat buka apps otomatis pas Windows nyala.

## Data, backup, sama pindah device

Pake installer? Pilih **Buka folder data** di menu tray buat nemuin `finance.db`, `.env`, sama folder `backups`. Kalo jalanin dari source, default-nya data ada di folder project.

Buat pindah device:

1. Keluar dari apps dan stop server di device lama.
2. Copy `finance.db`, `.env` kalo dipake, sama `finance.db-wal` dan `finance.db-shm` kalo masih ada.
3. Install dan buka apps di device baru, pilih **Buka folder data**, terus **Keluar**.
4. Taruh file tadi di folder data tujuan sebelum buka apps lagi. Kalo device tujuan udah punya data, backup dulu sebelum ditimpa.

Database sama `.env` isinya pribadi, jangan masukin repo atau file release. Folder data versi installer tetap ada setelah uninstall.

## Mau sync Gmail?

Ini opsional.

1. Aktifin verifikasi 2 langkah di akun Google, terus bikin [App Password](https://myaccount.google.com/apppasswords) (16 huruf).
2. Di dashboard klik **Hubungin Gmail** (atau tombol **Gmail** di atas), isi email, App Password, sama tanggal mulai baca email.
3. Klik **Tes koneksi**, terus **Simpan**. Abis itu tinggal klik **Cek mutasi**.

Di situ juga bisa milih **wallet utama**, buat transaksi yang email-nya nggak nyebut pocket/rekening. Cek hasilnya lewat log, karena format email yang bisa dibaca masih terbatas.

Masih bisa lewat `.env` di folder data kayak versi lama (`GMAIL_USER`, `GMAIL_APP_PASS`, `SYNC_START_DATE`, `SYNC_MAIN_WALLET`). Kalo diisi juga di apps, yang di apps yang dipake.

## Email yang kebaca

Sync pake Gmail kalian. Belum semua bank atau semua notif transaksi bisa kebaca; sekarang yang dikenali ini:

| Layanan | Email yang dikenali |
| --- | --- |
| Jago | Dari `noreply@jago.com`: duit masuk, pembayaran/transfer keluar, pindah kantong, tarik tunai, refund, cashback, atau bunga yang nominal dan formatnya dikenali |
| BCA | **Internet Transaction Journal / Jurnal Transaksi** myBCA buat pembayaran dan transfer keluar. Transfer ke rekening sendiri bisa dikenali kalo nama pemilik dan penerimanya cocok. Notif uang masuk BCA secara umum belum didukung |
| Pintu | Deposit dan penarikan Rupiah dari `support@pintu.co.id`. Dicatet sebagai pindah dana antar dompet, bukan beli/jual crypto |
| Bibit | Dari `no-reply@bibit.id`: **Pembayaran berhasil** (pindah dana ke dompet reksa dana), **Unit Reksa Dana Sudah Masuk** (jumlah unit dikoreksi sesuai email), **Dana Berhasil Dicairkan** (pindah dana balik ke bank). Perlu dompet reksa dana bertipe "Bibit" atau yang nyambung ke harga live reksa dana |
| Mandiri (Livin') | Dari `noreply.livin@bankmandiri.co.id`: pembayaran QR, transfer, transfer BI Fast, top-up e-wallet, top-up e-money. Yang **Tidak Berhasil** dilewatin. Udah dites pake email asli |
| Bank & e-wallet lain | BRI, BNI, BSI, CIMB Niaga, Permata, Danamon, BTN, SeaBank, OCBC, Jenius, blu, Superbank, Allo Bank, DANA, OVO, ShopeePay, LinkAja lewat **parser umum** (lihat di bawah). Belum dites pake email asli |
| GoPay | Pola **Riwayat Tagihan GoPay / Tagihan GoPay**, dicatet sebagai pengeluaran |
| Steam | Email pembelian/pembayaran dengan pola Steam yang dikenali dan nominal Rupiah |
| Itemku | Email pembelian dengan pola Itemku yang dikenali dan nominal Rupiah |

Batasannya sekarang:

- Cek **Inbox sama Spam**, maksimal **50 email terbaru per folder yang cocok sama filter pencarian**. Folder lain dan kandidat yang lebih lama belum diproses.
- Mulai dari tanggal **Baca email mulai** di Pengaturan Gmail. Kalo nggak diisi, default-nya tanggal 1 bulan ini.
- Parser umum nyari nominal `Rp` atau `IDR`, minimal Rp1.000. Belum konversi mata uang asing otomatis.
- Promo/newsletter dan format yang nggak dikenali dilewatin. Notif transaksi juga bisa kelewat kalo ada kata atau header yang kebaca sebagai newsletter.
- Email yang udah dicatet nggak diproses ulang. Ada pengecekan salinan forward sama penggabungan beberapa pasangan email transfer, tapi tetep cek hasilnya di log.
- Dompet dicocokin dari nama/tipe. Transfer yang belum nyambung ke dompet perlu kalian hubungin dulu sebelum saldonya dipindah.

### Parser umum buat bank lain

Email dari domain resmi bank/e-wallet di tabel atas dibaca pake pola yang umum dipake bank Indonesia, yaitu deretan "Label nilai":

- **Arah**: pembayaran, transfer, top-up, tarik tunai = keluar. Dana masuk, diterima, refund, cashback = masuk.
- **Nominal**: `Total Transaksi` / `Total Pembayaran` dulu (udah termasuk biaya), baru `Nominal` / `Jumlah`.
- **Keterangan**: dari `Penerima`, `Merchant`, `Pengirim`, dll. Transfer ke rekening atas nama sendiri dicatet sebagai pindah dana.
- **Wallet**: dicocokin ke dompet yang namanya/tipenya ada nama bank itu (misal dompet "Mandiri"). Kalo belum ada, transaksinya dicatet tanpa dompet.
- Notif gagal, kode OTP, e-statement, sama notif akun dilewatin. Kalo jenis atau nominalnya nggak jelas, emailnya dilewatin dan alasannya keliatan di log, bukan ditebak.

### Email bank kalian nggak kebaca?

Forward satu contoh emailnya ke **ibrahimhaykal@gmail.com**. Sensor dulu nomor rekening, saldo, sama data pribadi lain. Nanti formatnya ditambahin di update berikutnya. Saran lain juga boleh, lihat [Saran, bug, atau mau request fitur?](#saran-bug-atau-mau-request-fitur).

## Buat yang mau jalanin source

Pake React, Vite, Tailwind CSS, Express, SQLite (`better-sqlite3`), sama Electron.

Install Node.js 22.12+ atau 24+, lalu:

```sh
git clone https://github.com/ibrahimhaykal/celengin.git
cd celengin
npm ci
npm run app
```

Kalo mau development lewat browser:

```sh
npm run dev
```

Buka alamat Vite yang muncul di terminal. API jalan lokal di port 5000, versi desktop pake port 5123.

## Build installer sendiri

Jalanin di Windows buat bikin installer 64-bit:

```sh
npm ci
npm run release:win
```

Hasilnya di `release/Celengin-Setup-<versi>-x64.exe`. Database, backup, sama `.env` nggak ikut di installer.

File utamanya:

- `src/`: dashboard React.
- `server.js`: API sama skema database.
- `electron/`: jendela desktop, tray, sama ikon.

Commit source sama `package-lock.json`. Dependency, hasil build, database, backup, dan konfigurasi pribadi udah dikecualikan lewat `.gitignore`.

## Saran, bug, atau mau request fitur?

Hubungin gue aja di **ibrahimhaykal@gmail.com**, atau buka [issue di GitHub](https://github.com/ibrahimhaykal/celengin/issues). Semua masukan kepake, dari ide fitur, bug, sampe bank yang belum kebaca. Jangan kirim database, password, atau screenshot yang keliatan saldo sama nomor rekening, ya.
