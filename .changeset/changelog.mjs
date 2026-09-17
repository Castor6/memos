import upstream from "@changesets/cli/changelog";

// The upstream renderer indents every continuation line, including empty ones.
// Keep paragraphs and meaningful indentation while satisfying git diff --check.
const cleanBlankLines = (text) => text.replace(/^[\t ]+$/gm, "");

export default {
  async getReleaseLine(...args) {
    return cleanBlankLines(await upstream.getReleaseLine(...args));
  },
  async getDependencyReleaseLine(...args) {
    return cleanBlankLines(await upstream.getDependencyReleaseLine(...args));
  },
};
