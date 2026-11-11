/*
 * MessageAvatarStatus — a Vencord / Equicord userplugin
 *
 * Shows the presence dot (online / idle / do not disturb / offline) on the
 * avatars in the message list, so you can keep the member list closed.
 *
 * It reads the exact same store the member list reads (PresenceStore), so the
 * data is as fresh as the member list data — see README.md for the details.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, MessageStore, PresenceStore } from "@webpack/common";

import managedStyle from "./style.css?managed";

/* ------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The virtualised message list. `data-list-id="chat-messages"` is a plain,
 * non-minified attribute Discord has used for years (it is also what the
 * "jump to message" code paths rely on), so this survives Discord updates
 * far better than a patched minified class name would.
 */
const CHAT_LIST_SELECTOR = '[data-list-id="chat-messages"]';

/** Discord render avatars with CSS-module classes such as `avatar_c19a55`. */
const AVATAR_SELECTOR = 'img[class*="avatar_"]';

const DOT_CLASS = "vc-mas-dot";

/** Ignore tiny avatars (16px reply previews, embed thumbnails, …). */
const MIN_AVATAR_SIZE = 24;

/** `chat-messages-<channelId>-<messageId>` */
const MESSAGE_ELEMENT_ID = /^chat-messages-(\d{15,22})-(\d{15,22})$/;

/**
 * `cdn.discordapp.com/avatars/<userId>/<hash>.png` and
 * `cdn.discordapp.com/guilds/<guildId>/users/<userId>/avatars/<hash>.png`
 */
const CDN_USER_ID = /\/(?:avatars|users)\/(\d{15,22})\//;

const STATUS_LABELS: Record<string, string> = {
    online: "Online",
    idle: "Idle",
    dnd: "Do Not Disturb",
    offline: "Offline",
    streaming: "Streaming"
};

/* ------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* ------------------------------------------------------------------------- */

const settings = definePluginSettings({
    showOffline: {
        type: OptionType.BOOLEAN,
        description: "Also show the grey indicator for offline members (turn off to only see people who are around)",
        default: true
    },
    position: {
        type: OptionType.SELECT,
        description: "Where the indicator sits on the avatar",
        options: [
            { label: "Bottom right", value: "br", default: true },
            { label: "Bottom left", value: "bl" },
            { label: "Top right", value: "tr" },
            { label: "Top left", value: "tl" }
        ]
    },
    size: {
        type: OptionType.SELECT,
        description: "Indicator size",
        options: [
            { label: "Normal", value: "normal", default: true },
            { label: "Small", value: "small" },
            { label: "Large", value: "large" }
        ]
    },
    showTooltip: {
        type: OptionType.BOOLEAN,
        description: "Show the status name (and custom status) when hovering the indicator",
        default: true
    }
});

/* ------------------------------------------------------------------------- */
/*  DOM plumbing                                                              */
/* ------------------------------------------------------------------------- */

let listObserver: MutationObserver | null = null;
let bodyObserver: MutationObserver | null = null;

/** The message list element we are currently observing. */
let listEl: HTMLElement | null = null;

/** Avatars waiting to be decorated on the next animation frame. */
const pending = new Set<HTMLImageElement>();
let frame = 0;
let refreshQueued = false;

/**
 * `settings.store` is typed as the raw settings data, but at runtime it is the
 * SettingsStore instance, which is what exposes the change listeners.
 */
type ChangeAwareSettingsStore = {
    addGlobalChangeListener(cb: (data: any, path: string) => void): void;
    removeGlobalChangeListener(cb: (data: any, path: string) => void): void;
};

/**
 * Presence is not per-view: an avatar can move to a different message when
 * Discord recycles DOM nodes while scrolling, so everything is re-resolved
 * lazily from the element itself on every pass.
 */
function resolveUserId(img: HTMLImageElement): string | null {
    const url = img.currentSrc || img.src || "";

    const fromCdn = CDN_USER_ID.exec(url);
    if (fromCdn) return fromCdn[1];

    // Users without a custom avatar all share /embed/avatars/<n>.png, so fall
    // back to the message the avatar belongs to.
    const ids = getMessageIds(img);
    if (!ids) return null;

    try {
        return MessageStore.getMessage(ids.channelId, ids.messageId)?.author?.id ?? null;
    } catch {
        return null;
    }
}

function getMessageIds(img: HTMLImageElement) {
    const messageEl = img.closest<HTMLElement>('[id^="chat-messages-"]');
    if (!messageEl) return null;

    const match = MESSAGE_ELEMENT_ID.exec(messageEl.id);
    if (!match) return null;

    return { channelId: match[1], messageId: match[2] };
}

/** The guild the message belongs to, so per-guild presence is used like the member list does. */
function resolveGuildId(img: HTMLImageElement): string | null {
    const ids = getMessageIds(img);
    if (!ids) return null;

    try {
        return ChannelStore.getChannel(ids.channelId)?.guild_id ?? null;
    } catch {
        return null;
    }
}

/** Exactly what the member list does: fall back to "offline" when there is no presence. */
function getStatus(userId: string, guildId: string | null): string {
    try {
        const status = PresenceStore.getStatus(userId, guildId, "offline");
        if (!status || status === "invisible" || status === "unknown") return "offline";
        return status;
    } catch {
        return "offline";
    }
}

function getTooltip(userId: string, guildId: string | null, status: string) {
    let text = STATUS_LABELS[status] ?? "Offline";

    try {
        const custom = PresenceStore.findActivity(userId, (activity: any) => activity?.type === 4, guildId ?? undefined) as any;
        const state = custom?.state as string | undefined;
        if (state) text += ` — ${state}`;
    } catch {
        // custom status is privacy filtered sometimes, never fatal
    }

    return text;
}

function applyStatus(dot: HTMLElement) {
    const userId = dot.dataset.userId;
    if (!userId) return;

    const guildId = dot.dataset.guildId || null;
    const status = getStatus(userId, guildId);

    if (dot.dataset.status !== status) dot.dataset.status = status;

    const title = settings.store.showTooltip ? getTooltip(userId, guildId, status) : "";
    if (dot.title !== title) dot.title = title;
}

function createDot(img: HTMLImageElement, userId: string, guildId: string | null) {
    const host = img.parentElement;
    if (!host) return;

    const computed = getComputedStyle(host);
    if (computed.position === "static") host.style.position = "relative";

    // The attribute also carries a `position: relative` rule, so the dot stays
    // anchored even if React later rewrites the inline style of the wrapper.
    host.dataset.vcMasHost = "1";

    const dot = document.createElement("span");
    dot.className = DOT_CLASS;
    dot.setAttribute("aria-hidden", "true");
    dot.dataset.userId = userId;
    if (guildId) dot.dataset.guildId = guildId;

    // Rounded/overflow-hidden avatar wrappers would clip a dot that hangs over
    // the edge, so tuck it inside instead.
    if (computed.overflow !== "visible") dot.style.setProperty("--vc-mas-offset", "1px");

    // Clicking the dot is clicking the avatar, so profiles still open.
    dot.addEventListener("click", () => {
        host.querySelector("img")?.click();
    });

    applyStatus(dot);
    host.appendChild(dot);
}

function decorate(img: HTMLImageElement) {
    if (!img.isConnected) return;

    const host = img.parentElement;
    if (!host) return;

    // Reply previews and other incidental avatars are too small for a dot.
    if (img.offsetWidth > 0 && img.offsetWidth < MIN_AVATAR_SIZE) return;

    const userId = resolveUserId(img);
    if (!userId) return;

    const guildId = resolveGuildId(img);
    const existing = host.querySelector<HTMLElement>(`:scope > .${DOT_CLASS}`);

    if (existing) {
        // Same node recycled for a different message while scrolling.
        if (existing.dataset.userId !== userId) {
            existing.dataset.userId = userId;
            if (guildId) existing.dataset.guildId = guildId;
            else delete existing.dataset.guildId;
        }
        applyStatus(existing);
        return;
    }

    createDot(img, userId, guildId);
}

function queue(img: HTMLImageElement) {
    pending.add(img);
    if (!frame) frame = requestAnimationFrame(flush);
}

function flush() {
    frame = 0;

    const images = [...pending];
    pending.clear();

    for (const img of images) {
        try {
            decorate(img);
        } catch (err) {
            console.error("[MessageAvatarStatus] failed to decorate avatar", err);
        }
    }

    syncRootAttributes();
}

function scan(root: Element) {
    if (root instanceof HTMLImageElement && root.matches(AVATAR_SELECTOR)) queue(root);

    for (const img of root.querySelectorAll<HTMLImageElement>(AVATAR_SELECTOR)) {
        queue(img);
    }
}

function onListMutations(records: MutationRecord[]) {
    for (const record of records) {
        if (record.type === "attributes") {
            if (record.target instanceof HTMLImageElement) queue(record.target);
            continue;
        }

        for (const node of record.addedNodes) {
            if (node instanceof Element) scan(node);
        }
    }
}

function bindList() {
    const found = document.querySelector<HTMLElement>(CHAT_LIST_SELECTOR);

    if (found && found === listEl && found.isConnected) return;

    listObserver?.disconnect();
    listEl = found;

    if (!listEl) return;

    listObserver!.observe(listEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"]
    });

    scan(listEl);
}

/** Cheap "did the message list appear / get replaced" check. */
function onBodyMutations() {
    if (!listEl || !listEl.isConnected) bindList();
}

/* ------------------------------------------------------------------------- */
/*  Settings → CSS                                                            */
/* ------------------------------------------------------------------------- */

function setRootAttribute(name: string, value: string | null) {
    const root = document.documentElement;
    const current = root.getAttribute(name);

    if (value === null) {
        if (current !== null) root.removeAttribute(name);
    } else if (current !== value) {
        root.setAttribute(name, value);
    }
}

function syncRootAttributes() {
    setRootAttribute("data-vc-mas-position", settings.store.position);
    setRootAttribute("data-vc-mas-size", settings.store.size);
    setRootAttribute("data-vc-mas-tooltip", String(settings.store.showTooltip));
    setRootAttribute("data-vc-mas-hide-offline", settings.store.showOffline ? null : "1");
}

function refreshAll() {
    if (refreshQueued) return;
    refreshQueued = true;

    requestAnimationFrame(() => {
        refreshQueued = false;

        for (const dot of document.querySelectorAll<HTMLElement>(`.${DOT_CLASS}`)) {
            try {
                applyStatus(dot);
            } catch (err) {
                console.error("[MessageAvatarStatus] failed to update indicator", err);
            }
        }
    });
}

function refreshUser(userId: string) {
    for (const dot of document.querySelectorAll<HTMLElement>(`.${DOT_CLASS}[data-user-id="${userId}"]`)) {
        try {
            applyStatus(dot);
        } catch { /* ignore */ }
    }
}

function removeDots() {
    for (const dot of document.querySelectorAll(`.${DOT_CLASS}`)) dot.remove();

    for (const host of document.querySelectorAll<HTMLElement>("[data-vc-mas-host]")) {
        host.style.position = "";
        delete host.dataset.vcMasHost;
    }
}

/* ------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* ------------------------------------------------------------------------- */

export default definePlugin({
    name: "MessageAvatarStatus",
    description: "Shows the online / idle / do not disturb / offline indicator on the avatars of the messages people send, so you can keep the member list closed.",
    tags: ["Appearance", "Chat"],
    searchTerms: ["presence", "status", "member list", "offline", "dnd", "idle"],
    authors: [{ name: "artilon", id: 0n }],

    managedStyle,

    settings,

    flux: {
        PRESENCE_UPDATE: ({ user }: { user?: { id: string; }; }) => {
            if (user?.id) refreshUser(user.id);
        },
        // Batched presence payloads that some clients receive instead.
        PRESENCE_UPDATES: (event: { updates?: { user?: { id: string; }; }[]; } | undefined) => {
            for (const update of event?.updates ?? []) {
                if (update?.user?.id) refreshUser(update.user.id);
            }
        },
        // Fires when Discord lazily syncs member list ranges: this is the moment
        // presences we did not have yet become available.
        GUILD_MEMBER_LIST_UPDATE: () => refreshAll(),
        CONNECTION_OPEN: () => refreshAll()
    },

    start() {
        listObserver = new MutationObserver(onListMutations);
        bodyObserver = new MutationObserver(onBodyMutations);
        bodyObserver.observe(document.body, { childList: true, subtree: true });

        syncRootAttributes();
        (settings.store as unknown as ChangeAwareSettingsStore).addGlobalChangeListener(syncRootAttributes);

        bindList();
    },

    stop() {
        (settings.store as unknown as ChangeAwareSettingsStore).removeGlobalChangeListener(syncRootAttributes);

        bodyObserver?.disconnect();
        listObserver?.disconnect();
        bodyObserver = listObserver = null;

        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        refreshQueued = false;
        pending.clear();
        listEl = null;

        removeDots();

        const root = document.documentElement;
        delete root.dataset.vcMasPosition;
        delete root.dataset.vcMasSize;
        delete root.dataset.vcMasTooltip;
        delete root.dataset.vcMasHideOffline;
    }
});
