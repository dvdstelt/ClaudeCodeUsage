#!/usr/bin/env -S gjs -m
// Standalone check: validates the usage client against the live API.
//   gjs -m tools/poll.js   (run from the repository root)
import GLib from 'gi://GLib';
import {UsageClient} from '../src/lib/usageClient.js';

const loop = GLib.MainLoop.new(null, false);

async function run() {
    const client = new UsageClient();

    print('tier (from disk):', JSON.stringify(client.tierFromDisk()));

    const profile = await client.fetchProfile();
    print('\nprofile:');
    print('  max:', profile.account?.has_claude_max, '| pro:', profile.account?.has_claude_pro);
    print('  org type:', profile.organization?.organization_type);
    print('  rate tier:', profile.organization?.rate_limit_tier);

    const usage = await client.fetchUsage();
    print('\nusage windows:');
    for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
        const w = usage[key];
        if (w)
            print(`  ${key}: ${w.utilization}%  resets ${w.resets_at}`);
        else
            print(`  ${key}: (null)`);
    }
    if (usage.extra_usage)
        print(`  extra_usage: ${usage.extra_usage.used_credits}/${usage.extra_usage.monthly_limit} ${usage.extra_usage.currency}`);
}

run()
    .catch(e => {
        printerr('ERROR:', e.message);
        if (e.body)
            printerr('BODY:', e.body);
        imports.system.exit(1);
    })
    .finally(() => loop.quit());

loop.run();
