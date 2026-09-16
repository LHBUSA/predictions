const citation = 'PropBetEdge Predictions. “Federal Reserve target-rate decision.” Forecast record PBE-FED-2026-09-001. Model v0.1.0. Illustrative V3 research interface.';

async function copyText(text, button, success = 'Copied') {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = success;
  } catch {
    button.textContent = 'Ready to copy';
  }
  setTimeout(() => { button.textContent = original; }, 1400);
}

document.querySelector('#copy-record-citation')?.addEventListener('click', e => copyText(citation, e.currentTarget, 'Citation copied'));
document.querySelector('#copy-citation-side')?.addEventListener('click', e => copyText(citation, e.currentTarget, 'Citation copied'));
document.querySelector('#copy-record-link')?.addEventListener('click', e => copyText(window.location.href, e.currentTarget, 'Link copied'));

document.querySelectorAll('.chart-range').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.chart-range').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
  });
});
