// Node-side entry: where the built web UI lives, for the local node to serve.
import { fileURLToPath } from 'node:url';

export const webAssetsDir = fileURLToPath(new URL('./dist/app/', import.meta.url));
