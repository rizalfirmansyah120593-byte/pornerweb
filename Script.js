(function () {
  let ready = false;
  let opened = false;

  // Aktif setelah 60 detik
  setTimeout(function () {
    ready = true;
  }, 60000);

  function openLinkOnce() {
    if (!ready || opened) return;

    opened = true;
    window.open('https://pornerweb.pro', '_blank', 'noopener');
  }

  // Desktop
  document.addEventListener('click', openLinkOnce);

  // Mobile
  document.addEventListener('touchstart', openLinkOnce, { passive: true });
})();
