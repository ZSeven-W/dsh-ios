// Client libraries belong to the DSH host's module-loader realm. Bundling
// another React copy breaks hooks even when the package installs cleanly.
export default {
  deps: {
    neverBundle: [/^react(?:\/|$)/, /^react-dom(?:\/|$)/, /^@deepseek-ai\//],
  },
};
