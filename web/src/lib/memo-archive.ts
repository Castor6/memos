/** Download a portable archive without retaining its bytes in component state. */
export function downloadMemoArchive(content: Uint8Array, filename: string): void {
  const blob = new Blob([new Uint8Array(content)], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "memos-export.zip";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
