// Ícones desenhados para o labsign: grade 24, traço 1.75, pontas arredondadas.
const svg = (body: string, size = 18): string =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  nib: (s?: number) => svg('<path d="M12 2.8l5.6 8.4L12 21.2 6.4 11.2 12 2.8z"/><path d="M12 12.6v8.6"/><circle cx="12" cy="11" r="1.5"/>', s),
  check: (s?: number) => svg('<path d="M5 12.6l4.3 4.3L19 7.2"/>', s),
  chevronLeft: (s?: number) => svg('<path d="M14.5 6l-6 6 6 6"/>', s),
  chevronRight: (s?: number) => svg('<path d="M9.5 6l6 6-6 6"/>', s),
  pen: (s?: number) => svg('<path d="M4.5 19.5l1.1-4.2L15.8 5.1a2 2 0 012.8 0l.3.3a2 2 0 010 2.8L8.7 18.4l-4.2 1.1z"/><path d="M13.8 7.1l3.1 3.1"/>', s),
  undo: (s?: number) => svg('<path d="M9 14L4.5 9.5 9 5"/><path d="M4.5 9.5H15a5 5 0 010 10h-3"/>', s),
  shield: (s?: number) => svg('<path d="M12 3.2l7.2 2.9v5.5c0 4.4-3.1 7.9-7.2 9.2-4.1-1.3-7.2-4.8-7.2-9.2V6.1L12 3.2z"/><path d="M9 12.2l2.1 2.1 4-4.2"/>', s),
  alert: (s?: number) => svg('<path d="M10.3 4.3L2.9 17.2A2 2 0 004.6 20h14.8a2 2 0 001.7-2.8L13.7 4.3a2 2 0 00-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 16.8h.01"/>', s),
  lock: (s?: number) => svg('<rect x="5" y="10.8" width="14" height="9.7" rx="2.2"/><path d="M8.2 10.8V8a3.8 3.8 0 017.6 0v2.8"/>', s),
  move: (s?: number) => svg('<path d="M12 4v16M4 12h16"/><path d="M9.5 6.5L12 4l2.5 2.5M9.5 17.5L12 20l2.5-2.5M6.5 9.5L4 12l2.5 2.5M17.5 9.5L20 12l-2.5 2.5"/>', s),
  x: (s?: number) => svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', s),
  plus: (s?: number) => svg('<path d="M12 5.5v13M5.5 12h13"/>', s),
  trash: (s?: number) => svg('<path d="M4.5 7h15"/><path d="M9.5 7V4.8h5V7"/><path d="M6.5 7l.9 12.2h9.2l.9-12.2"/><path d="M10.2 10.5v5.5M13.8 10.5v5.5"/>', s),
  download: (s?: number) => svg('<path d="M12 4.5v10.5"/><path d="M7.5 10.8L12 15.3l4.5-4.5"/><path d="M5 19.5h14"/>', s),
  folder: (s?: number) => svg('<path d="M3.8 6.8h5.4l1.8 2h9.2v9.7H3.8V6.8z"/>', s),
  share: (s?: number) => svg('<path d="M12 15V4.5"/><path d="M8 8.3l4-3.8 4 3.8"/><path d="M6.5 11.5H5v8h14v-8h-1.5"/>', s),
  mail: (s?: number) => svg('<rect x="3.8" y="5.8" width="16.4" height="12.4" rx="1"/><path d="M4.3 6.6l7.7 6.2 7.7-6.2"/>', s),
  chat: (s?: number) => svg('<path d="M4.5 18.8l1.1-3.6A7.6 7.6 0 1112 19.6a7.8 7.8 0 01-3.9-1l-3.6.2z"/>', s),
  chevronDown: (s?: number) => svg('<path d="M6 9.5l6 6 6-6"/>', s),
  file: (s?: number) => svg('<path d="M6.5 3.5h7.3l3.7 3.7v13.3h-11V3.5z"/><path d="M13.5 3.8v3.7h3.7"/><path d="M9 12.5h6M9 15.8h6"/>', s),
};
