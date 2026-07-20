[treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
      // FORK: Embedded plugins
      ...(embeddedPluginsMap ? { "embedded-plugins.gen.ts": embeddedPluginsMap } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      parserWorker,
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
      // FORK: Embedded plugins
      ...(embeddedPluginsMap ? ["embedded-plugins.gen.ts"] : []),
    ],