type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

const paths = {
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 2-2 M8 9h8 M8 13h5',
  spaces: 'M3 4h7v7H3z M14 4h7v7h-7z M3 15h7v6H3z M14 15h7v6h-7z',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 11v1a7 7 0 0 0 14 0v-1 M12 19v3 M8 22h8',
  send: 'M4 12h16 M14 6l6 6-6 6',
  calibrate: 'M12 2v4 M12 18v4 M2 12h4 M18 12h4 M19 12a7 7 0 1 1-14 0 7 7 0 1 1 14 0 M14 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0',
  refresh: 'M20 10a8 8 0 0 0-14-5L3 8 M3 3v5h5 M4 14a8 8 0 0 0 14 5l3-3 M21 21v-5h-5',
  glasses: 'M2 9h8v7H2z M14 9h8v7h-8z M10 11h4 M2 9l2-4 M22 9l-2-4',
  image: 'M3 3h18v18H3z M3 17l6-6 4 4 3-3 5 5 M15 7h.01',
  camera: 'M3 7h4l2-3h6l2 3h4v14H3z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  check: 'M4 12l5 5L20 6', close: 'M6 6l12 12 M6 18 18 6',
  arrow: 'M5 12h14 M14 7l5 5-5 5', back: 'M19 12H5 M10 7l-5 5 5 5',
  help: 'M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  copy: 'M8 8h12v13H8z M16 8V3H3v13h5',
  network: 'M5 17v4h4v-4z M15 17v4h4v-4z M9 3h6v6H9z M12 9v5 M7 17v-3h10v3',
  home: 'M3 11l9-8 9 8 M6 9v12h12V9 M10 21v-7h4v7',
  phone: 'M7 2h10v20H7z M11 18h2',
  cloud: 'M6 18a5 5 0 1 1 1-10 6 6 0 0 1 11 1 4.5 4.5 0 0 1 0 9z',
  pause: 'M8 5v14 M16 5v14',
} as const;
export type IconName = keyof typeof paths;
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name]); svg.append(path);
  return svg;
}
export function button(label: string, action: () => void, options: { secondary?: boolean; highlighted?: boolean; icon?: IconName; className?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const b = el('button', `even-button ${options.className ?? ''}`.trim(), options.icon ? icon(options.icon) : null, el('span', '', label));
  if (options.secondary) b.classList.add('even-button--secondary');
  if (options.highlighted) b.classList.add('even-button--highlighted');
  b.type = 'button'; b.disabled = Boolean(options.disabled); b.addEventListener('click', action); return b;
}
export function externalLink(label: string, href: string): HTMLAnchorElement {
  const a = el('a', 'text-link', label, icon('arrow')); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
