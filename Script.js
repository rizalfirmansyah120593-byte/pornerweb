(function () {
  let ready = false;
  let opened = false;

  // Aktif setelah 10 detik
  setTimeout(function () {
    ready = true;
  }, 10000);

  function openLinkOnce() {
    if (!ready || opened) return;

    opened = true;
    window.open('https://alwaysmulticulturallanding.com/fvgf9mfp03?key=1c10044c464902764bd74cc28120d87e', '_blank', 'noopener');
  }

  // Desktop
  document.addEventListener('click', openLinkOnce);

  // Mobile
  document.addEventListener('touchstart', openLinkOnce, { passive: true });
})();
