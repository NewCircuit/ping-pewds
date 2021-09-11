import {Guild, GuildMember, Message, MessageEmbedOptions} from 'discord.js';
import Controller from './controller';
import Bot from '../Bot';
import { CONFIG } from '../globals';
import { Parsed } from '../database/types';

export type FlaggedMention = {
    user: string;
    role?: string;
    type: TargetType
};

export type PunishmentType = 'ban' | 'mute' | 'kick';

export type TargetType = 'role' | 'user';

type StandardPunishment = {
    target: 'standard',
}

type TargetedPunishment = {
    target: 'role' | 'user';
    targetKey: string;
}

type DefaultPunishmentProps = {
    lenient: boolean;
    length: number | null;
    type: PunishmentType
    target: TargetType;
}

type Punishment = DefaultPunishmentProps & (StandardPunishment | TargetedPunishment)

type PunishmentCache = {
    role: {
        [s: string]: Punishment[];
    };
    user: {
        [s: string]: Punishment[];
    }
}

export default class PunishmentController extends Controller {

    private punishments: PunishmentCache;

    public constructor(bot: Bot) {
        super(bot, 'PunishmentController');

        this.punishments = this.organizePunishments();
    }

    public async synchronize(): Promise<void> {
        const db = this.bot.getDatabase();
        const activePunishments = await db.punishmentHistory.getAllLatest();

        const punishments = await db.punishments.getAllActive()
        this.punishments = this.organizePunishments(
            punishments
        );

        const guild = this.bot.guilds.resolve(CONFIG.bot.guild);
        if (guild === null) throw new Error('Guild not found.');
        const sync = this.syncPunishment(guild);
        await Promise.all(activePunishments.map(sync));
    }

    public syncPunishment(
        guild: Guild
    ): (punishment: Parsed.PunishmentHistoryWithCount | null) => Promise<void> {
        const db = this.bot.getDatabase();
        return async (punishment: Parsed.PunishmentHistoryWithCount | null) => {
            if (punishment === null) {
                return;
            }

            const shouldRemovePunishment =
                punishment.endsAt !== null &&
                punishment.endsAt.getTime() < Date.now() &&
                punishment.active;

            if (!shouldRemovePunishment)
                return;

            const member = await guild.members.fetch(punishment.userId)
            if (member) {
                await member.roles.remove(CONFIG.bot.muteRole);
            }

            try {
                await guild.members.unban(
                    punishment.userId,
                    'They have served their sentence.'
                );
                await db.punishmentHistory.setActive(punishment.id, false);
                this.getLogger().info(
                    `${punishment.userId} has served their sentence.`
                );
            } catch (noop) {
                // should only catch if the user was unbanned manually
                // and we shouldn't care about them.
            }

        };
    }

    public async punish(message: Message, mentions: FlaggedMention[]): Promise<void> {
        const author = message.author.id;
        const guild = message.guild;
        if (guild === null) {
            throw new Error('guild not found.');
        }

        const guildMember = message.guild?.members.resolve(author);
        if (guildMember === null || typeof guildMember === 'undefined') {
            throw new Error('selected user is not a guild member somehow');
        }

        const db = this.bot.getDatabase();
        const currentPunishments = await db.punishmentHistory.getByUserId(
            guildMember.user.id,
            true
        );

        // TODO create a lenient role that has lighter punishments
        //      necessary for the tiered roles to have lighter punishments since they are patrons


        const hasLenientRole = CONFIG.bot.lenientRoles.findIndex((role) => {
            return guildMember.roles.resolve(role) !== null;
        }) >= 0;

        let punishments: Punishment[] = [];

        for (const mention of mentions) {
            if (punishments.length > 0)
                break;
            punishments.push(
                ...this.getPunishments(
                    mention.type,
                    hasLenientRole,
                    mention.type === 'user'
                        ? mention.user
                        : mention.type === 'role' && mention.role
                            ? mention.role
                            : undefined
                )
            );
        }

        if (punishments.length === 0 && hasLenientRole) {
            this.getLogger().warn({
                error: 'No lenient punishments found.',
                mentions,
            })
            return;
        }

        const nextPunishment = punishments[Math.min(currentPunishments.length, punishments.length - 1)];

        const endsAt = typeof nextPunishment.length === 'number' ? Date.now() + nextPunishment.length : true;

        await db.punishmentHistory.create({
            userId: author,
            endsAt,
        })

        await this.handleDiscordPunishment(
            message,
            nextPunishment,
            mentions,
            currentPunishments,
            endsAt
        );
    }

    public isMonitoredMember(author?: GuildMember | null): boolean {
        const hasMonitoredRole = Object.keys(this.punishments.role)
            .findIndex((role) => (
                author?.roles.resolve(role) !== null
            )) >= 0
        const isMonitoredUser = this.punishments.user[author?.id || 0] instanceof Array;

        return isMonitoredUser || hasMonitoredRole;
    }

    private async handleDiscordPunishment(
        message: Message,
        punishment: Punishment,
        mentions: FlaggedMention[],
        punishmentHistory: Array<Parsed.PunishmentHistory | null>,
        endsAt: number | true
    ) {
        const duration = endsAt === true ? 'the end of time' : `<t:${Math.round(endsAt / 1000)}>`
        let description: string | undefined;

        switch (punishment.type) {
            case 'ban':
                description = `You've been banned until ${duration} for pinging the following people.`
                break;
            case 'mute':
                description = `You've been muted until ${duration} for pinging the following people.`
                break;
            case 'kick':
                description = `You've been kicked for pinging the following people.`
                break;
        }

        const embed: MessageEmbedOptions = {
            title: `You've been banned on ${message.guild?.name} server.`,
            timestamp: Date.now(),
            footer: {
                text: `C'mon, you know better than this!`,
            },
            description,
            fields: [
                {
                    name: 'Mentioned Users',
                    value: mentions.map((mention) => `<@${mention.user}>`).join(', ')
                },
                {
                    name: 'Punishment History',
                    value: punishmentHistory.length > 0 ? punishmentHistory.map((pun) => {
                        return `Punished at <t:${Math.round((pun?.createdAt.getTime() || 0) / 1000)}>`
                    }).join('\n') : 'No previous punishments'
                }
            ],
            color: 'RED',
        };

        const channel = await message.author.createDM();
        await channel.send({
            embeds: [embed]
        });

        // skip the actual punishment for testing
        if (CONFIG.bot.dryrun)
            return true;

        switch (punishment.type) {
            case 'ban':
                await message.guild?.members.ban(message.author, {
                    reason: `Pinging people they shouldn't ping.`
                });
                break;
            case 'mute':
                const member = message.guild?.members.resolve(message.author);
                member?.roles.add(CONFIG.bot.muteRole);
                break;
            default:
                this.getLogger().error(`Unhandled punishment type ${punishment.type}`);
        }
    }

    public hasPunishments(target: TargetType, targetKey?: string): boolean {
        if (typeof targetKey === 'string')
            return this.punishments[target][targetKey].length > 0;
        return false;
    }

    public getBlockedUsers() {
        return Object.keys(this.punishments.user)
    }

    public getBlockedRoles() {
        return Object.keys(this.punishments.role);
    }

    private getPunishments(target: TargetType, lenient: boolean, targetKey?: string): Punishment[] {
        if (typeof targetKey === 'string' && this.punishments[target][targetKey])
            return this.punishments[target][targetKey].filter((k) => k.lenient === lenient);
        return [];
    }

    private organizePunishments(punishments?: Punishment[]) {
        const nextCache: PunishmentCache = {
            role: {},
            user: {}
        }
        if (typeof punishments === 'undefined')
            return nextCache;

        punishments.forEach((punishment) => {
            switch (punishment.target) {
                case 'user':
                    if (typeof nextCache.user[punishment.targetKey] === 'undefined')
                        nextCache.user[punishment.targetKey] = [];
                    nextCache.user[punishment.targetKey].push(punishment);
                    break;
                case 'role':
                    if (typeof nextCache.role[punishment.targetKey] === 'undefined')
                        nextCache.role[punishment.targetKey] = [];
                    nextCache.role[punishment.targetKey].push(punishment);
                    break;
            }
        })
        return nextCache;
    }
}
