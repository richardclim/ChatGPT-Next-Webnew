## 2025-05-07 - Update icon button ARIA labels in sidebar
**Learning:** Cloned or copied icon buttons without text often retain misassigned `aria` labels (e.g., `Message From ChatGPT` on a GitHub repository link) or lack them entirely, leaving them inaccessible to screen readers. The `IconButton` component relies entirely on its `aria` prop for semantic meaning when no visible text is present.
**Action:** Always verify `aria` labels and `title` attributes on `IconButton` components to ensure they accurately describe the button's action or destination.
