window.setAmbientSlide = async function (slide) {
  const root = document.getElementById('ambient-export');
  await window.renderAmbientSlide(root, slide);
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  document.documentElement.dataset.ready = 'true';
  return true;
};
