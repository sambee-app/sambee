import api from "./api";

export { FilesystemSearchStartError } from "./api";

export const startFilesystemSearch: typeof api.startFilesystemSearch = (...args) => api.startFilesystemSearch(...args);
