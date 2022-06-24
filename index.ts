import { basename, extname, resolve } from 'path'
import { readdir, readFile } from 'fs/promises'
import { hash as blake3hash } from 'blake3-wasm'
import * as mime from 'mime'
import from from '@adamburgess/linq'
import { setTimeout } from 'timers/promises'

// broken packages are broken dude.
const getType: typeof mime.getType = 'getType' in mime ? mime.getType : (mime as unknown as { default: typeof mime }).default.getType;

const BASE_URL = 'https://api.cloudflare.com/client/v4';

interface RequestOptions {
    headers?: Record<string, string>,
    body?: any
    log?: (msg: string) => unknown
}

async function doRequest<T = unknown>(url: string, apiKey: string, options: RequestOptions = {}) {
    url = BASE_URL + url;
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': '@adamburgess/cloudflare-pages-direct-upload@0.0.1',
        ...options.headers
    };

    if (options.body && typeof options.body === 'string') {
        headers['Content-Type'] = 'application/json'
    }

    const res = await fetch(url, {
        headers,
        method: options.body ? 'POST' : 'GET',
        body: options.body
    });

    const txt = await res.text();
    const type = res.headers.get('content-type');
    if (!type || !type.includes('application/json')) {
        throw new Error('expecting json ' + txt);
    }

    return JSON.parse(txt) as { result: T, success: true } | { success: false, errors: { code: number, message: string }[] };
}

async function doRequestWithRetries<T = unknown>(url: string, apiKey: string, options: RequestOptions = {}, retries = 5) {
    let lastError: unknown;
    let retryCount = 0;
    while (retryCount++ !== retries) {
        try {
            const result = await doRequest<T>(url, apiKey, options);
            return result;
        } catch (e) {
            lastError = e;
            const delay = Math.min(Math.pow(retryCount, 2.5), 60) * 1000;
            (options.log ?? (() => { }))(`Failed to request ${url}, delaying for ${delay} ms: ${e}`);
            await setTimeout(delay);
        }
    }
    throw lastError;
}

async function getJwt({ accountId, projectName, apiKey }: CloudflarePagesDirectUploaderOptions) {
    const res = await doRequestWithRetries<{ jwt: string }>(`/accounts/${accountId}/pages/projects/${projectName}/upload-token`, apiKey);
    if (res.success) return res.result.jwt;
    throw new Error('couldnt get jwt ' + JSON.stringify(res, null, 2));
}

async function getMissingHashes(jwt: JWTCache, hashes: string[], options: CloudflarePagesDirectUploaderOptions) {
    const res = await doRequestWithRetries<string[]>('/pages/assets/check-missing', options.apiKey, {
        headers: {
            'Authorization': `Bearer ${await jwt.get(options)}`
        },
        body: JSON.stringify({
            hashes
        })
    });

    if (res.success) {
        return res.result;
    }
    throw new Error('failed... ' + JSON.stringify(res.errors));
}

interface FileWithHash {
    contentBase64: string
    hash: string
    contentType: string
}

async function uploadFile(jwt: JWTCache, files: FileWithHash[], options: CloudflarePagesDirectUploaderOptions) {
    const payload = files.map(f => ({
        key: f.hash,
        value: f.contentBase64,
        metadata: {
            contentType: f.contentType
        },
        base64: true
    }));

    const json = JSON.stringify(payload);
    const res = await doRequestWithRetries('/pages/assets/upload', options.apiKey, {
        headers: {
            'Authorization': `Bearer ${await jwt.get(options)}`
        },
        body: json
    });
    if (!res.success) {
        throw new Error('failed to upload....' + JSON.stringify(res.errors));
    }
}

async function upsertHashes(jwt: JWTCache, hashes: string[], options: CloudflarePagesDirectUploaderOptions) {
    const res = await doRequestWithRetries('/pages/assets/upsert-hashes', options.apiKey, {
        headers: {
            'Authorization': `Bearer ${await jwt.get(options)}`
        },
        body: JSON.stringify({
            hashes
        })
    });
    if (!res.success) {
        throw new Error('failed to upsert....' + JSON.stringify(res.errors));
    }
}

async function createDeployment(body: FormData, { accountId, projectName, apiKey }: CloudflarePagesDirectUploaderOptions) {
    const res = await doRequestWithRetries<{ url: string, id: string }>(`/accounts/${accountId}/pages/projects/${projectName}/deployments`, apiKey, {
        body
    });

    if (res.success) return res.result;
    throw new Error('failed to deploy...' + JSON.stringify(res.errors));
}

class JWTCache {
    private jwt: {
        jwt: string
        expiry: Date
    } | undefined = undefined;

    async get(options: CloudflarePagesDirectUploaderOptions) {
        if (this.jwt === undefined || this.jwt.expiry < new Date()) {
            const jwt = await getJwt(options);
            const json = Buffer.from(jwt.split('.')[1], 'base64').toString()
            const parsed = JSON.parse(json) as { exp: number };
            this.jwt = {
                jwt,
                expiry: new Date(parsed.exp * 1000 - 60000)
            };
        }
        return this.jwt.jwt;
    }
}

export interface DeployOptions {
    apiKey: string
    accountId: string
    projectName: string

    branch?: string
    commitMessage?: string
    commitHash?: string
}
export interface DeploymentFile {
    filename: string
    content: Buffer | (() => Promise<Buffer>)
    /** Leave blank to use mime on npm to get the type. */
    contentType?: string
    /** Precompute yourself with `computeHash` or leave blank. */
    hash?: string
}

type DeploymentFileWithHash = DeploymentFile & {
    hash: string
} & ({ contentBase64: string } | { contentBase64: undefined, content: () => Promise<Buffer> })


export interface Deployment {
    id: string
    url: string
    hashes: Record<string, string>
}

export interface DeploymentOptions {
    branch?: string
    commitMessage?: string
    commitHash?: string
    headers?: string
    redirects?: string
    worker?: string
    concurrency?: number
    log?: (msg: string) => unknown
}

export interface CloudflarePagesDirectUploaderOptions {
    apiKey: string
    accountId: string
    projectName: string
}

export class CloudflarePagesDirectUploader {
    constructor(private config: CloudflarePagesDirectUploaderOptions) {
    }

    async deployDirectory(directoryPath: string, options?: DeploymentOptions) {
        async function* readDirRecursive(path: string): AsyncIterable<string> {
            const dirents = await readdir(path, { withFileTypes: true });
            for (const dirent of dirents) {
                const res = resolve(path, dirent.name);
                if (dirent.isDirectory()) {
                    yield* readDirRecursive(res);
                } else {
                    yield res;
                }
            }
        }

        if (!options) options = {};

        const base = resolve(directoryPath);
        const files: [string, string][] = [];
        for await (const file of readDirRecursive(base)) {
            const relative = file.substring(base.length + 1);
            if (relative === '_headers') {
                if (!options.headers) options.headers = await readFile(file, 'utf8');
                continue;
            } else if (relative === '_redirects') {
                if (!options.redirects) options.redirects = await readFile(file, 'utf8');
                continue;
            } else if (relative === '_worker.js') {
                if (!options.worker) options.worker = await readFile(file, 'utf8');
                continue;
            }
            files.push([file, relative]);
        }

        return this.deployFiles(
            files.map(([fn, relative]) => ({
                filename: relative,
                content: () => readFile(fn)
            })),
            options
        );
    }

    async deployFiles(files: DeploymentFile[], options?: DeploymentOptions): Promise<Deployment> {
        const jwt = new JWTCache();
        const log = options?.log ?? (msg => undefined);

        // compute the hashes
        for (const file of files) {
            if (!file.hash) {
                const content = (typeof file.content === 'function' ? (await file.content()) : file.content).toString('base64');
                file.hash = computeHashB64(content, file.filename);
                (file as DeploymentFileWithHash).contentBase64 = content;
            }
        }
        const filesWithHash = files as DeploymentFileWithHash[]

        const grouped = from(filesWithHash)
            .groupBy(x => x.hash)
            .toArray();

        // find missing hashes
        const missingHashes = await getMissingHashes(jwt, grouped.map(g => g.key), this.config);
        // upload missing files
        // do four at a time.
        const concurrency = Math.min(options?.concurrency ?? 4, 1);
        const promises: Promise<void>[] = [];
        const hashesToUpload = missingHashes.slice();
        for (let i = 0; i < concurrency; i++) {
            promises.push((async () => {
                while (hashesToUpload.length > 0) {
                    const missingHash = hashesToUpload.pop()!;

                    const file = filesWithHash.find(x => x.hash === missingHash)!;
                    log(`file ${file.filename}/${file.hash} missing, uploading.`)
                    const contentBase64 = file.contentBase64 ?? (await file.content()).toString('base64');
                    const contentType = file.contentType ?? getType(file.filename) ?? 'application/octet-stream';

                    await uploadFile(jwt, [{ contentBase64, contentType, hash: file.hash }], this.config);
                    log(`uploaded file ${file.filename}/${file.hash}`);
                }
            })());
        }
        await Promise.all(promises);

        // upsert the new list of hashes
        if (missingHashes.length) {
            await upsertHashes(jwt, grouped.map(g => g.key), this.config);
        }

        // deploy the files
        const manifest = Object.fromEntries(filesWithHash.map(f => ['/' + f.filename, f.hash]));

        const formData = new FormData();
        formData.append('manifest', JSON.stringify(manifest));
        if (options?.branch) {
            formData.append('branch', options.branch);
        }
        if (options?.commitMessage) {
            formData.append('commit_message', options.commitMessage);
        }
        if (options?.commitHash) {
            formData.append('commit_hash', options.commitHash);
        }
        if (options?.headers) {
            formData.append('_headers', new Blob([options.headers]), '_headers');
        }
        if (options?.redirects) {
            formData.append('_redirects', new Blob([options.redirects]), '_redirects');
        }
        if (options?.worker) {
            formData.append('_worker.js', new Blob([options.worker]), '_worker.js');
        }

        const deployment = await createDeployment(formData, this.config);

        return {
            ...deployment,
            hashes: from(filesWithHash).toObject(x => x.filename, x => x.hash)
        };
    }
}

export default CloudflarePagesDirectUploader;

export function computeHash(content: Buffer, filename: string) {
    return computeHashB64(content.toString('base64'), filename);
}

function computeHashB64(b64: string, filename: string) {
    const extension = extname(basename(filename)).substring(1);
    return blake3hash(b64 + extension).toString('hex').slice(0, 32);
}
