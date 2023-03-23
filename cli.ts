#!/usr/bin/env node
import { resolve } from 'path';
import { CloudflarePagesDirectUploader } from './index.js'

function usage(): never {
    console.log('Usage: ')
    console.log('CF_API_TOKEN=token CF_ACCOUNT_ID=id cloudflare-pages-direct-upload PROJECT [DIRECTORY]');
    console.log('If directory is not specified, the current directory is used.');
    process.exit(1);
}

const args = process.argv.slice(2);
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

const result = await uploader.deployDirectory(dir, {
    log(msg) {
        console.log(msg);
    }
});

console.log('deployed', result.url);
