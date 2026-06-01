#!/usr/bin/env node
import { previewTicketSessionCleanup, runTicketSessionCleanup } from '../api/ticket-session-cleanup.js';

function parseArgs(argv) {
  const args = { dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--enforce') {
      args.dryRun = false;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--retention-days') {
      args.retentionDays = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--statuses') {
      args.cleanupStatuses = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const result = args.dryRun
  ? previewTicketSessionCleanup(args)
  : await runTicketSessionCleanup(args);

console.log(JSON.stringify(result, null, 2));
