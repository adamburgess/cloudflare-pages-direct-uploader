# @adamburgess/cloudflare-pages-direct-uploader

Uploads a list of files or a directory directly to Cloudflare Pages using the [Direct Upload](https://developers.cloudflare.com/pages/platform/direct-upload/) Wrangler API.

[![npm version](https://img.shields.io/npm/v/@adamburgess/cloudflare-pages-direct-uploader)](https://www.npmjs.com/package/@adamburgess/cloudflare-pages-direct-uploader) [![npm type definitions](https://img.shields.io/npm/types/@adamburgess/cloudflare-pages-direct-uploader)](https://unpkg.com/browse/@adamburgess/cloudflare-pages-direct-uploader/index.d.ts)

Warning: Currently the API routes used are not documented/private. This could break at any time.

If you are using this on a version of Node <18, you must polyfill the global namespace with your own `fetch`, `FormData`, and `File`, e.g. with `undici`.

Usage:

```ts
import CFPagesUploader from '@adamburgess/cloudflare-pages-direct-uploader'

const uploader = new CFPagesUploader({
    // create an API Token with the "Account.Cloudflare Pages" permission, or use your global API key
    apiKey: 'XXXXXXXXX',
    // https://developers.cloudflare.com/fundamentals/get-started/basic-tasks/find-account-and-zone-ids/
    accountId: 'XXXXXXXXX',
    projectName: 'your-pages-name'
});

// all are optional. omit if you want.
const options = {
    branch: 'main',
    commitMessage: 'Deployment at ' + new Date().toString(),
    commitHash: 'abc123',
    headers: 'Contents of the _headers file',
    redirects: 'Contents of the _redirects file',
    worker: 'Contents of the _worker.js file'
}
// note: when deploying a directory, the headers/redirects/worker files will be read from the disk.
//       they don't need to be specified.

// to upload a directory:
const deployment = await uploader.deployDirectory(directoryPath, options);

// to upload a list of files:
const files = [
    // normal usage, specify filename and content as a Buffer.
    { filename: 'index.html', content: Buffer.from('this is the index') },
    // optionally, specify a content-type:
    { filename: 'image.jxl', content: jxlBuffer, contentType: 'image/jxl' },
    // if the file is large, precompute and provide the hash for the file and set compute to an async function.
    // only if the file is necessary to upload will the function be called.
    // to precompute the hash, see the next section.
    { filename: 'large-file.zip', content: () => readFile('large-file.zip'), hash: 'XXXXXX' }
];
const deployment = await uploader.deployFiles(files, options);
/* deployment is: {
    url: link to the deployed page
    id: the unique id of this deployment
    hashes: a map of filename -> hash
}
*/
```

### How to precompute the hash

If you don't know the hash for a file, just omit it, and then read the deployment object which has the hash.

Or:
```ts
import { computeHash } from '@adamburgess/cloudflare-pages-direct-uploader'
const hash = computeHash(content, filename);
```
