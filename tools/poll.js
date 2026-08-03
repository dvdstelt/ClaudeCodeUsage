#!/usr/bin/env -S gjs -m
// Standalone check: validates the usage client against the live API.
//   gjs -m tools/poll.js                    (uses ~/.claude)
//   gjs -m tools/poll.js ~/.claude-work      (a second Claude Code profile)
import GLib from 'gi://GLib';
import {UsageClient, defaultConfigDir} from '../src/lib/usageClient.js';

const loop = GLib.MainLoop.new(null, false);

// GJS exposes extra script arguments as the global ARGV regardless of module
// mode. Accept an absolute path, a ~/-relative path, or a path relative to cwd.
function resolveConfigDir(arg) {
    if (!arg)
        return defaultConfigDir();
    if (arg.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), arg.slice(2)]);
    if (GLib.path_is_absolute(arg))
        return arg;
    return GLib.build_filenamev([GLib.get_current_dir(), arg]);
}

const configDir = resolveConfigDir(typeof ARGV !== 'undefined' ? ARGV[0] : undefined);

async function run() {
    const client = new UsageClient({configDir});

    print('config dir:', configDir);
    print('tier (from disk):', JSON.stringify(await client.tierFromDisk()));

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
