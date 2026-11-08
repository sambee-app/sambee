/* Purpose: Watches docs inputs and refreshes generated inheritance route anchors. */

const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");

const chokidar = require("chokidar");

const siteRoot = path.resolve(__dirname, "..");
const docsContentRoot = path.join(siteRoot, "content", "docs");
const devDocsOutputRoot = path.join(siteRoot, "public-dev", "docs");
const manifestPath = path.join(siteRoot, "public-dev", "docs-routes.json");
const watchedPaths = [
   docsContentRoot,
   path.join(siteRoot, "data", "docs-nav"),
   path.join(siteRoot, "data", "docs-versions.toml"),
];
const debounceMs = 350;
const markerNames = new Set(["inherit.md", "_inherit.md"]);
const pageNames = new Set(["index.md", "_index.md"]);

let debounceTimer = null;
let isMaterializing = false;
let shouldMaterializeAgain = false;
const pendingPageRefreshes = new Set();
const pendingOutputRemovals = new Set();
const pendingPageIdentityChecks = new Set();
const ignoredChangePaths = new Set();
let hasPendingStructuralChange = false;
let redirectTimer = null;
let isGeneratingRedirects = false;
let shouldGenerateRedirectsAgain = false;

function generateRedirects() {
   if (isGeneratingRedirects) {
      shouldGenerateRedirectsAgain = true;
      return;
   }
   isGeneratingRedirects = true;
   shouldGenerateRedirectsAgain = false;
   const child = spawn("python3", ["scripts/generate-managed-redirects.py", "--output", "public-dev/_redirects"], {
      cwd: siteRoot,
      stdio: ["ignore", "inherit", "inherit"],
   });
   child.on("error", (error) => {
      console.error(`[docs] HTTP rule refresh failed: ${error.message}`);
   });
   child.on("close", (code) => {
      isGeneratingRedirects = false;
      if (code !== 0) {
         console.error("[docs] HTTP rules are not current. Correct the reported migration or target, then rebuild.");
      }
      if (shouldGenerateRedirectsAgain) {
         generateRedirects();
      }
   });
}

const redirectWatcher = chokidar.watch([manifestPath, path.join(siteRoot, "platform-redirects.txt")], {
   ignoreInitial: true,
   awaitWriteFinish: { stabilityThreshold: debounceMs, pollInterval: 100 },
});
redirectWatcher.on("all", () => {
   clearTimeout(redirectTimer);
   redirectTimer = setTimeout(generateRedirects, debounceMs);
}).on("error", (error) => {
   console.error(`[docs] HTTP rule watcher failed: ${error.message}`);
});

function pagePathForMarker(markerPath) {
   const pageName = path.basename(markerPath) === "_inherit.md" ? "_index.md" : "index.md";
   return path.join(path.dirname(markerPath), pageName);
}

async function removeStaleOutputs() {
   const sourcePaths = [...pendingOutputRemovals];
   pendingOutputRemovals.clear();

   for (const sourcePath of sourcePaths) {
      const relativePath = path.relative(docsContentRoot, sourcePath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
         continue;
      }

      const outputDirectory = path.join(devDocsOutputRoot, path.dirname(relativePath));
      const outputPath = path.basename(sourcePath) === "_index.md"
         ? path.join(outputDirectory, "index.html")
         : outputDirectory;

      try {
         await fs.rm(outputPath, { force: true, recursive: true });
      } catch (error) {
         console.error(`[docs] Could not remove stale output ${outputPath}: ${error.message}`);
      }
   }
}

async function refreshMaterializedPages() {
   const refreshedPaths = [...pendingPageRefreshes];
   pendingPageRefreshes.clear();

   for (const filePath of refreshedPaths) {
      try {
         await fs.access(filePath);
         ignoredChangePaths.add(filePath);
         const now = new Date();
         await fs.utimes(filePath, now, now);
      } catch (error) {
         if (error.code !== "ENOENT") {
            console.error(`[docs] Could not refresh ${filePath}: ${error.message}`);
         }
      }
   }
}

function materializeRoutes() {
   if (isMaterializing) {
      shouldMaterializeAgain = true;
      return;
   }

   isMaterializing = true;
   shouldMaterializeAgain = false;
   console.log("[docs] Refreshing inherited documentation routes");

   const child = spawn("python3", ["scripts/materialize-inherited-docs.py"], {
      cwd: siteRoot,
      stdio: ["ignore", "inherit", "inherit"],
   });

   child.on("error", (error) => {
      console.error(`[docs] Route refresh failed: ${error.message}`);
   });

   child.on("exit", async (code) => {
      isMaterializing = false;

      if (code === 0) {
         console.log("[docs] Inherited documentation routes refreshed");
         await removeStaleOutputs();
         await refreshMaterializedPages();
      } else {
         console.error(`[docs] Route refresh failed with exit code ${code}`);
      }

      if (shouldMaterializeAgain) {
         materializeRoutes();
      }
   });
}

async function processPendingChanges() {
   const pageIdentityPaths = [...pendingPageIdentityChecks];
   pendingPageIdentityChecks.clear();

   for (const sourcePath of pageIdentityPaths) {
      try {
         await fs.access(sourcePath);
      } catch (error) {
         if (error.code === "ENOENT") {
            pendingOutputRemovals.add(sourcePath);
            hasPendingStructuralChange = true;
         } else {
            console.error(`[docs] Could not inspect ${sourcePath}: ${error.message}`);
         }
      }
   }

   if (!hasPendingStructuralChange) {
      return;
   }

   hasPendingStructuralChange = false;
   materializeRoutes();
}

function scheduleMaterialization(event, filePath) {
   const absolutePath = path.resolve(filePath);
   if (event === "change" && ignoredChangePaths.delete(absolutePath)) {
      return;
   }

   const fileName = path.basename(absolutePath);
   const isMetadata = absolutePath === path.join(siteRoot, "data", "docs-versions.toml") ||
      absolutePath.startsWith(path.join(siteRoot, "data", "docs-nav") + path.sep);
   const isMarker = markerNames.has(fileName);
   const isPageIdentity = pageNames.has(fileName);
   const isPageIdentityChange = isPageIdentity && event !== "change";

   if (!isMetadata && !isMarker && !isPageIdentity) {
      return;
   }

   if (isPageIdentity) {
      pendingPageIdentityChecks.add(absolutePath);
   }

   if (isMarker && event === "unlink") {
      pendingPageRefreshes.add(pagePathForMarker(absolutePath));
   }

   if (isPageIdentityChange && event === "unlink") {
      pendingOutputRemovals.add(absolutePath);
   }

   hasPendingStructuralChange ||= isMetadata || isMarker || isPageIdentityChange;
   clearTimeout(debounceTimer);
   debounceTimer = setTimeout(() => {
      void processPendingChanges();
   }, debounceMs);
}

const watcher = chokidar.watch(watchedPaths, {
   ignoreInitial: true,
   awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
   },
});

watcher
   .on("add", (filePath) => scheduleMaterialization("add", filePath))
   .on("change", (filePath) => scheduleMaterialization("change", filePath))
   .on("unlink", (filePath) => scheduleMaterialization("unlink", filePath))
   .on("ready", () => {
      console.log("[docs] Watching docs inputs for inherited route refreshes");
   })
   .on("error", (error) => {
      console.error(`[docs] Watcher error: ${error.message}`);
   });

function shutdown() {
   clearTimeout(debounceTimer);
   clearTimeout(redirectTimer);
   Promise.all([watcher.close(), redirectWatcher.close()]).finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
