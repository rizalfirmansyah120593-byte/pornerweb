import pkg from './Pornhub.js-master/dist/index.js';
const { videoSearch, PornHub } = pkg;

async function testSearch() {
    try {
        const ph = new PornHub(); 
        
        console.log("Mencoba mencari video...");
        
        // PENTING: Gunakan ph.engine, bukan ph
        const result = await videoSearch(ph.engine, 'indonesian', { page: 1 }); 
        
        console.log("Hasil pencarian berhasil:");
        console.log(result);
    } catch (error) {
        console.error("Terjadi kesalahan:", error.message);
    }
}

testSearch();