/**
 * The graphics example programs (examples/graphics), bundled into the app as
 * text so "Graphics examples" works offline and copies them into the
 * workspace as an ordinary project.
 */
const files = import.meta.glob('../../examples/graphics/*.{py,md}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const GRAPHICS_EXAMPLES_PROJECT = 'Graphics Examples';
export const GRAPHICS_EXAMPLES_ENTRY = '01_shapes_and_colors.py';

export const GRAPHICS_EXAMPLES: Record<string, string> = Object.fromEntries(
  Object.entries(files)
    .map(([path, text]) => [path.slice(path.lastIndexOf('/') + 1), text] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b)),
);
