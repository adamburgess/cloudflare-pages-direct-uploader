#!/usr/bin/env node
import { resolve } from 'path';
import { CloudflarePagesDirectUploader } from './index.js'
import mri from 'mri'

function usage(): never {
    console.log('Usage: ')
    console.log('CF_API_TOKEN=token CF_ACCOUNT_ID=id cloudflare-pages-direct-upload [--branch=BRANCH] PROJECT [DIRECTORY]');
    console.log('If directory is not specified, the current directory is used.');
    console.log('A branch can be used for deploy previews.');
    process.exit(1);
}

const parsed = mri<{ branch: string | undefined }>(process.argv.slice(2), {
    alias: { 'b': 'branch' },
    string: ['branch']
});
const args = parsed._;

if (args.length < 1 || args.length > 2) {
    usage();
}

const projectName = args[0];
const dir = args[1] ? resolve(args[1]) : process.cwd();

const apiKey = process.env.CF_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID;

if (apiKey === undefined || accountId === undefined) {
    usage();
}

const uploader = new CloudflarePagesDirectUploader({
    accountId,
    apiKey,
    projectName
});

console.log('deploying project', projectName, ...(parsed.branch ? ['on branch', parsed.branch] : []));
const result = await uploader.deployDirectory(dir, {
    branch: parsed.branch,
    log(msg) {
        console.log(msg);
    }
});

console.log('deployed', result.url);
