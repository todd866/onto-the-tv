/* Shared, local-only renderer for the screensaver preview and TV export page. */
(function () {
  function safe(value) { return value == null ? '' : String(value); }
  const revisions = new WeakMap();
  const images = new Map();
  function dispose(container) {
    for (const video of container.querySelectorAll('video')) { video.pause(); video.removeAttribute('src'); video.load(); }
  }
  async function renderAmbientSlide(container, slide) {
    const revision = (revisions.get(container) || 0) + 1;
    revisions.set(container, revision);
    if (!slide) { dispose(container); container.replaceChildren(); return container; }
    const next = document.createElement('div');
    next.className = `ambient-slide ambient-slide-${safe(slide?.kind).toLowerCase() || 'weather'}`;
    const content = document.createElement('div'); content.className = 'ambient-slide-content';
    if (slide.kind === 'weather-film' && String(slide.video).startsWith('file:')) {
      const video = document.createElement('video');
      video.className = 'ambient-film'; video.muted = true; video.loop = true; video.playsInline = true;
      video.preload = 'auto'; video.src = slide.video; video.setAttribute('aria-label', safe(slide.title));
      next.append(video);
    }
    const eyebrow = document.createElement('p'); eyebrow.className = 'ambient-slide-eyebrow'; eyebrow.textContent = safe(slide?.eyebrow);
    const title = document.createElement('h2'); title.className = 'ambient-slide-title'; title.textContent = safe(slide?.title);
    const detail = document.createElement('p'); detail.className = 'ambient-slide-detail'; detail.textContent = safe(slide?.detail);
    content.append(eyebrow, title, detail);
    if (/^photo\s*\d*$/i.test(safe(slide?.title))) title.hidden = true;
    if (Array.isArray(slide?.forecast) && slide.forecast.length) {
      const forecast = document.createElement('div'); forecast.className = 'ambient-forecast';
      for (const item of slide.forecast.slice(0, 5)) {
        const cell = document.createElement('div'); cell.className = 'ambient-forecast-cell';
        const label = document.createElement('span'); label.textContent = safe(item.label);
        const value = document.createElement('strong'); value.textContent = safe(item.value);
        cell.append(label, value); forecast.append(cell);
      }
      content.append(forecast);
    }
    if (slide?.image && String(slide.image).startsWith('file:')) {
      const image = document.createElement('img'); image.className = 'ambient-slide-image'; image.alt = safe(slide.title); image.decoding = 'async'; image.src = safe(slide.image);
      next.append(image);
    }
    const footer = document.createElement('p'); footer.className = 'ambient-slide-footer'; footer.textContent = safe(slide?.footer || slide?.sourceUrl || '');
    content.append(footer); next.append(content);
    const image = next.querySelector('img');
    if (image) {
      if (!images.has(image.src)) images.set(image.src, image.decode().catch(error => { images.delete(image.src); throw error; }));
      await images.get(image.src);
      while (images.size > 18) images.delete(images.keys().next().value);
      await image.decode();
    }
    const film = next.querySelector('video');
    if (film && film.readyState < 2) await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); film.onloadeddata = null; film.onerror = null; error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error('Weather preview took too long to load.')), 8000);
      film.onloadeddata = () => finish(); film.onerror = () => finish(new Error('Weather preview could not load.'));
      film.load();
    });
    if (revisions.get(container) !== revision) { dispose(next); return container; }
    dispose(container);
    container.replaceChildren(next);
    const video = next.querySelector('video');
    if (video && container.id === 'ambient-stage' && !container.closest('[hidden]')) void video.play().catch(() => {});
    if (container.id === 'ambient-stage' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      next.animate([{ opacity:0, transform:'translateY(4px)' }, { opacity:1, transform:'translateY(0)' }], { duration:800, easing:'ease-out' });
    }
    return container;
  }
  window.renderAmbientSlide = renderAmbientSlide;
}());
