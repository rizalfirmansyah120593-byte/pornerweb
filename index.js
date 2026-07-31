// Contoh cara menggunakannya
const ph = require('pornhub.js'); // Sesuaikan dengan cara import yang benar di library ini

async function ambilData() {
    try {
        const video = await ph.search('kunci pencarian');
        console.log(video);
    } catch (error) {
        console.error("Gagal mengambil data:", error);
    }
}
app.get('/search', async (req, res) => {
    const keyword = req.query.q; // Mengambil 'indonesia' dari ?q=indonesia
    
    if (!keyword) {
        return res.send("Masukkan kata kunci pencarian!");
    }

    try {
        // Panggil fungsi search yang sudah kita buat tadi
        const results = await ph.search(keyword, { page: 1 }); 
        
        // Kirim hasil ke template (misalnya EJS) atau JSON
        res.render('index', { 
            data: results, 
            title: 'Hasil: ' + keyword,
            query: keyword,
            currentPage: 1 
        });
    } catch (error) {
        res.status(500).send("Terjadi kesalahan saat mencari video.");
    }
});

ambilData();