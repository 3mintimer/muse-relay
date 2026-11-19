// The dial is a single focusable slider. SVG coordinates stay the same at
// every phone width, so dragging the marker follows the actual head angle.
export function headAngleDial(label: string, value: number, change: (angle: number) => void) {
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
    const labelY = a === 0 ? y - 5 : y + 4;
    return '<path d="M' + point(a, 192) + ' L' + point(a, 185) + '"/><text class="' + (a > value ? 'in-zone' : '') + '" x="' + x + '" y="' + labelY + '">' + a + '°</text>';
  }).join('');
  function draw() {
    const [x,y] = point(value, 192);
    svg.setAttribute('aria-valuenow', String(value));
    svg.setAttribute('aria-valuetext', value + '°');
    svg.innerHTML = `<path class="wake-zone" d="M34 190 L${point(68,192)} A192 192 0 0 1 ${x} ${y} Z"/>
      <g class="angle-scale"><path d="M34 190 H226 A192 192 0 0 0 ${point(68,192)}"/>${ticks()}</g>
      <g class="angle-marker"><path d="M34 190 L${x} ${y}"/><circle cx="${x}" cy="${y}" r="7"/></g>
      <text class="angle-value" x="${x+13}" y="${y-5}">${value}°</text>
      <g class="angle-profile" aria-hidden="true" transform="translate(0 170) scale(.57)"
         fill="none" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 59c4-4 6-8 6-13 0-4-4-7-7-13C3 16 14 5 29 5c12 0 20 7 20 18l1 6 5 8c1 2 0 3-2 3h-3l-1 6c-1 4-3 6-7 6l-6-1c-1 4 0 6 3 9"/>
        <path d="M29 30c-2-4-7-3-7 1 0 4 2 7 5 7"/>
        <path d="M15 26c8-2 13-2 22-1m-1-1c4-2 10-2 15-1l-1 7c0 3-2 4-6 4h-2c-3 0-5-2-5-5z" stroke-width="3.2"/>
      </g>
      <circle class="angle-handle" cx="${x}" cy="${y}" r="18" fill="transparent"/>`;
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
  let dragPointer: number | null = null;
  svg.onpointerdown = e => {
    if (!e.isPrimary || (e.pointerType === 'touch' && !(e.target instanceof Element && e.target.matches('.angle-handle')))) return;
    dragPointer = e.pointerId;
    svg.setPointerCapture(e.pointerId);
    move(e);
  };
  svg.onpointermove = e => { if (dragPointer === e.pointerId) move(e); };
  svg.onpointerup = e => {
    // A background tap sets the angle. A vertical swipe scrolls and sends pointercancel.
    if (!e.isPrimary) return;
    if (e.pointerType === 'touch' && dragPointer === null) move(e);
    dragPointer = null;
  };
  svg.onlostpointercapture = e => { if (dragPointer === e.pointerId && e.target === svg) dragPointer = null; };
  svg.onkeydown = e => {
    const keys: Record<string, number> = {ArrowRight:value+1, ArrowUp:value+1, ArrowLeft:value-1, ArrowDown:value-1, Home:10, End:60};
    if (Object.hasOwn(keys, e.key)) { e.preventDefault(); update(keys[e.key]!); }
  };
  draw();
  return svg;
}
