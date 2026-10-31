/** Keep an anchored menu inside its own MCP App viewport, flipping above if needed. */
export function menuPosition(anchor, { width = 240, height = 220, viewportWidth, viewportHeight, gap = 6, margin = 8, align = 'end' }) {
  const availableWidth = Math.max(0, viewportWidth - margin * 2);
  const availableHeight = Math.max(0, viewportHeight - margin * 2);
  const actualWidth = Math.min(width, availableWidth);
  const actualHeight = Math.min(height, availableHeight);
  const preferredLeft = align === 'start' ? anchor.left : anchor.right - actualWidth;
  const left = Math.max(margin, Math.min(preferredLeft, viewportWidth - actualWidth - margin));
  const below = anchor.bottom + gap;
  const above = anchor.top - actualHeight - gap;
  const top = below + actualHeight <= viewportHeight - margin ? below : above >= margin ? above : margin;
  return { left, top, width: actualWidth, maxHeight: availableHeight };
}
