// The dial is a single focusable slider. SVG coordinates stay the same at
// every phone width, so dragging the marker follows the actual head angle.
export function headAngleDial(label: string, value: number, change: (angle: number) => void, drag: (active: boolean) => void) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 278 210');
  svg.classList.add('head-angle');
  svg.setAttribute('role', 'slider');
  svg.setAttribute('tabindex', '0');
  svg.dataset.focus = 'head-angle';
  svg.setAttribute('aria-label', label);
  svg.setAttribute('aria-valuemin', '10');
  svg.setAttribute('aria-valuemax', '60');
  function point(angle: number, radius: number) {
    const rad = angle * Math.PI / 180;
    return [34 + radius * Math.cos(rad), 190 - radius * Math.sin(rad)];
  }
  const ticks = () => Array.from({length: 7}, (_, i) => {
    const a = 10 * i, [x,y] = point(a, 170);
    return '<path d="M' + point(a, 192) + ' L' + point(a, 185) + '"/><text class="' + (a > value ? 'in-zone' : '') + '" x="' + x + '" y="' + (y + 4) + '">' + a + '°</text>';
  }).join('');
  function draw() {
    const [x,y] = point(value, 192);
    svg.setAttribute('aria-valuenow', String(value));
    svg.setAttribute('aria-valuetext', value + '°');
    svg.innerHTML = `<path class="wake-zone" d="M34 190 L${point(68,192)} A192 192 0 0 1 ${x} ${y} Z"/>
      <g class="angle-scale"><path d="M34 190 H226 A192 192 0 0 0 ${point(68,192)}"/>${ticks()}</g>
      <g class="angle-marker"><path d="M34 190 L${x} ${y}"/><circle cx="${x}" cy="${y}" r="7"/></g>
      <text class="angle-value" x="${x+13}" y="${y-5}">${value}°</text>
      <path class="angle-profile" d="M8 204 v-12 q-8-12 1-20 q8-6 14 1 l2 6 4 4 -4 1 -1 7 -7 1 v12 z M13 177 h11"/>`;
  }
  function update(angle: number) {
    value = Math.min(60, Math.max(10, Math.round(angle)));
    draw(); change(value);
  }
  function move(e: PointerEvent) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    update(Math.atan2(190 - p.y, p.x - 34) * 180 / Math.PI);
  }
  svg.onpointerdown = e => { drag(true); svg.setPointerCapture(e.pointerId); move(e); };
  svg.onpointermove = e => { if (svg.hasPointerCapture(e.pointerId)) move(e); };
  svg.onlostpointercapture = () => drag(false);
  svg.onkeydown = e => {
    const keys: Record<string, number> = {ArrowRight:value+1, ArrowUp:value+1, ArrowLeft:value-1, ArrowDown:value-1, Home:10, End:60};
    if (Object.hasOwn(keys, e.key)) { e.preventDefault(); update(keys[e.key]!); drag(false); }
  };
  draw();
  return svg;
}
