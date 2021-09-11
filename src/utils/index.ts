import {GuildMember, Message} from "discord.js";
import {CONFIG} from "../globals";

export function minutesToReadable(minutes?: number) {
    if (typeof minutes !== 'number') {
        return '0 minutes'
    }
    let hours = 0;
    let days = 0;
    if (minutes >= 60) {
        hours = minutes / 60
        minutes = minutes % 60;
    }
    if (hours >= 24) {
        days = hours / 24;
        hours = hours % 24;
    }
    let str = '';
    if (minutes > 0) {
        str = `${Math.floor(minutes)} minutes`
    }
    if (hours > 0) {
        str = `${Math.floor(hours)} hours, ` + str;
    }
    if (days > 0) {
        str = `${Math.floor(days)} days, ` + str;
    }
    return str;
}

export function sentByAuthorizedUser(author?: GuildMember | null) {
    return CONFIG.bot.moderatorRoles.findIndex((role) => (
        author?.roles.resolve(role) !== null
    )) >= 0
}
