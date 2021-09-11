import {ApplyOptions} from "@sapphire/decorators";
import {Args, Command, CommandContext, CommandOptions} from "@sapphire/framework";
import {SubCommandPluginCommand, SubCommandPluginCommandOptions} from "@sapphire/plugin-subcommands";
import {Message, MessageEmbed, MessageEmbedOptions, Role, User} from "discord.js";
import Bot from "../../Bot";
import {Nullable, Parsed, PunishmentType, Tables, TargetType} from "../../database/types";
import {InsertError, DatabaseError} from "../../database/errors";
import {minutesToReadable, parsedUserOrRole, sentByAuthorizedUser} from "../../utils";
import {CONFIG} from "../../globals";

const disclaimer = `*By entering the above command, you will receive an embed that will show you the full structure of the command.*`

@ApplyOptions<SubCommandPluginCommandOptions>({
    name: 'punishments',
    description: 'Show, create, and remove punishments for pinging them from users and roles',
    preconditions: ['GuildOnly'],
    subCommands: [
        {
            input: 'help',
            default: true,
        },
        {
            input: 'list',
        },
        {
            input: 'create',
        },
        {
            input: 'for'
        },
        {
            input: 'remove'
        }
    ]
})
export default class Punishments extends SubCommandPluginCommand {

    private static hasPermission(message: Message) {
        const author = message.guild?.members.resolve(message.author.id);
        return sentByAuthorizedUser(author)
    }

    public async run(message: Message, args: Args, context: CommandContext) {
        if (!Punishments.hasPermission(message)) return;
        await super.run(message, args, context);
    }

    public async help(message: Message): Promise<void> {

        message.channel.send({
            content: `For more help than what is provided in the embed below, click the button below to view bot documentation.`,
            embeds: [
                Punishments.HELP_EMBED
            ],
            components: [
                {
                    type: 'ACTION_ROW',
                    components: [
                        {
                            type: 'BUTTON',
                            // TODO change to commands documentation instead of default readme
                            url: 'https://github.com/NewCircuit/ping-pewds',
                            label: 'Github Repo',
                            style: 'LINK'
                        }
                    ]
                }
            ]
        })
    }

    public async list(message: Message): Promise<void> {
        const bot = this.container.client as Bot;
        const punishmentController = bot.getPunishmentController();
        const rolePunishments = punishmentController.getBlockedRoles();
        const userPunishments = punishmentController.getBlockedUsers();

        const mapPunishments = (target: TargetType) => (key: string): MessageEmbedOptions => {
            const punishment = punishmentController.getPunishment(target, key)
            if (punishment)
                return Punishments.LIST_PUNISHMENTS_EMBED(punishment);
            return {
                title: `${parsedUserOrRole(target, key)} has no punishments`
            }
        }

        const embeds = [
            ...rolePunishments
                .filter((k) => punishmentController.hasPunishments('role', k))
                .map(mapPunishments('role')),
            ...userPunishments
                .filter((k) => punishmentController.hasPunishments('user', k))
                .map(mapPunishments('user'))
        ]

        if (embeds.length === 0) {
            await message.channel.send({
                content: `There are no punishments set up. 
Run the command \`${CONFIG.bot.prefix}punishments create\` to learn how to create commands.`
            })
            return;
        }

        let first = true;
        do {
            let subsetEmbeds = embeds.splice(0, 10);
            await message.channel.send({
                content: first
                    ? `Here is a list of punishments that can be given out, broken down by user and role.`
                    : undefined,
                embeds: subsetEmbeds,
            })
            first = false;
        } while (embeds.length > 0);
    }

    public async create(message: Message, args: Args): Promise<void> {
        const parsedArgs = await Punishments.parseCreateArgs(args)
            .catch((err) => {
                console.error(err)
                return null
            });

        if (parsedArgs === null) {
            // TODO send embed with command structure
            await message.channel.send({
                embeds: [ Punishments.CREATE_PUNISHMENT_EMBED ],
            });
            return;
        }

        const bot = this.container.client as Bot;
        const created = await bot.getDatabase().punishments.create({
            index: parsedArgs.index,
            target: parsedArgs.target,
            targetKey: parsedArgs.targetKey,
            type: parsedArgs.type,
            length: parsedArgs.length ? parsedArgs.length * 1000 * 60 : undefined,
            lenient: parsedArgs.lenient,
        }).catch((err: InsertError) => err);

        if (created instanceof DatabaseError) {
            message.channel.send({
                content: `An error occurred while trying to create the punishment.
Please notify a developer so that we can check the internal logs`
            })
            this.container.logger.info(created)
            return;
        }

        await message.reply({
            allowedMentions: { users: [], roles: [], repliedUser: false },
            content: `Successfully added punishment to ${parsedArgs.target} ${Punishments.getRoleOrUser(parsedArgs)}.
\`\`\`Punishment Type: ${parsedArgs.type}
Punishment Target: ${parsedArgs.target}
Punishment Target Key: ${Punishments.getRoleOrUser(parsedArgs)}
Punishment is lenient: ${parsedArgs.lenient}
Punishment length ${minutesToReadable(parsedArgs.length)}
\`\`\``
        })

        await bot.getPunishmentController().synchronize();
    }

    public async for(message: Message, args: Args): Promise<void> {
        let targetUser: User;

        try {
            targetUser =  await args.pick('user');
        }  catch (_) {
            // Invalid input was provided
            message.channel.send({
                content: `An invalid user was provided.
Usage: \`${CONFIG.bot.prefix}punishments for (@user|User ID)\``
            })
            return;
        }
        const bot = this.container.client as Bot;
        const db = bot.getDatabase();
        const punishments = await db.punishmentHistory.getByUserId(targetUser.id, true, true);


        let first = true;
        do {
            let subsetEmbeds = punishments.splice(0, 10);
            message.channel.send({
                allowedMentions: { users: [] },
                content: first
                    ? `Here is a list of punishments for <@${targetUser.id}>.`
                    : undefined,
                embeds: [
                    Punishments.LIST_PUNISHMENT_HISTORY(targetUser, subsetEmbeds)
                ]
            })
            first = false;
        } while (punishments.length > 0);

        console.log(targetUser, punishments);
    }

    private static getRoleOrUser(args: Tables.Punishments.CreateObject) {
        if (args.target === 'role')
            return `<@&${args.targetKey}>`
        if (args.target === 'user')
            return `<@${args.targetKey}>`;
        return args.targetKey;
    }

    private static async parseCreateArgs(argsObj: Args): Promise<Tables.Punishments.CreateObject> {
        const numeric = /^(\.|\d)+$/;
        const mention = /^<(@&?!?)(.*)>$/
        const argsStr = (await argsObj.rest('string') || '').toLowerCase()
        let [
            index, type, target, targetKey, lenient, length
        ]: any[] = argsStr.split(/\s+/);

        if (index.match(numeric) === null)
            throw new Error('index must be numeric')
        index = Number.parseInt(index);

        if (['ban','kick','mute'].indexOf(type) === -1)
            throw new Error('punishment type is invalid')

        const requiresTargetKey = ['user', 'role'].indexOf(target);
        if (requiresTargetKey === -1)
            throw new Error('punishment target is invalid')

        const mentionedMatch = targetKey.match(mention)
        if (targetKey.match(numeric) === null && mentionedMatch === null)
            throw new Error('punishment target key must be numeric')

        if (mentionedMatch !== null) {
            // replace the mention string with just the ID
            targetKey = mentionedMatch[2] as string;
        }

        if (['1', '0', 'yes', 'no', 'true', 'false'].indexOf(lenient.toLowerCase()) === -1)
            throw new Error('punishment leniency must be boolean(ish)')
        lenient = (['1', 'yes', 'true'].indexOf(lenient) >= 0)

        if ((length?.match(numeric) || null) === null)
            length = undefined;
        else
            length = Number.parseInt(length, 10)

        return {
            index,
            type,
            target,
            targetKey,
            lenient,
            length,
        }
    }

    private static LIST_PUNISHMENTS_EMBED = (punishments: Parsed.Punishment[]): MessageEmbedOptions => {
        return ({
            title: `Punishments for pinging ${punishments[0].target}`,
            description: 'The following punishments are in order based on their **Priority Index**. This is the order in which punishments are handed out.',
            fields: [
                {
                    name: 'Applies to:',
                    value: `**${punishments[0].target} ${parsedUserOrRole(punishments[0].target, punishments[0].targetKey)}**`
                },
                {
                    inline: true,
                    name: 'Lenient Punishments',
                    value: Punishments.GENERATE_PUNISHMENTS_VALUE(punishments, true),
                },
                {
                    inline: true,
                    name: 'Standard Punishments',
                    value: Punishments.GENERATE_PUNISHMENTS_VALUE(punishments),
                },
            ]
        })
    }

    private static GENERATE_PUNISHMENTS_VALUE(punishments: Parsed.Punishment[], isLenient = false) {
        return punishments
            .filter(({lenient}) => isLenient === lenient)
            .map(({ length, type, index}) => (
                `*#${index}*, **${type}** for ___${minutesToReadable((length || 0) / 1000) || 'eternity'}___`
            )).join('\n');
    }

    private static LIST_PUNISHMENT_HISTORY(user: User, history: Parsed.PunishmentHistory[]): MessageEmbedOptions {
        const endTime = (item: Parsed.PunishmentHistory) => item.endsAt ? `<t:${item.endsAt.getTime() / 1000}>` : '**the end of time**'
        const expiresTime = (item: Parsed.PunishmentHistory) => item.expiresAt ? `<t:${item.expiresAt.getTime() / 1000}>` : '**the end of time**'
        const isPast = (item: Parsed.PunishmentHistory) => item.endsAt ? Date.now() > item.endsAt.getTime() : false;
        return {
            title: `Ping Punishments for ${user.username}`,
            description: `The following is a list of punishments in order in which they were given. This includes expired and completed punishments\n`
            + (history.length > 0 ?  '' : '\n**There is no punishment history.**'),
            fields: history.map((item, idx) => ({
                name: `Punishment #${idx + 1} ${isPast(item) ? '___*No Longer Active*___' : ''}`,
                value: `Punishment Given at <t:${item.createdAt.getTime() / 1000}>
Punishment Completes at ${endTime(item)}
Punishment Expires at ${expiresTime(item)}`
            }))
        }
    }

    private static CREATE_PUNISHMENT_EMBED: MessageEmbedOptions = {
        title: 'How To Create A Punishment',
        description: `The following command is the structure you should use when creating a punishment via this command
\`!punishments create [PriorityIndex] [Type] [Target] [TargetKey] [Lenient] [Length?]\``,
        fields: [
            {
                name: 'Priority Index',
                value: '`Numeric, [0 - 10000]` (lower number means punishment is give first)'
            },
            {
                name: 'Type',
                value: '`Ban | Mute | Kick` (the type of punishment)'
            },
            {
                name: 'Target',
                value: '`Role | User` (role means anyone with the role will have ping protection)'
            },
            {
                name: 'Target Key',
                value: '`@user | @role | Role ID | User ID` (You can mention a user or role, or you can input the ID of the role or user)'
            },
            {
                name: 'Lenient',
                value: '`yes | no | true | false` (allows you to have two different types of punishments based on the punished users role, bros vs tiered punishment)'
            },
            {
                name: 'Length *(optional)*',
                value: '`numeric | nothing` The length of the punishment in minutes (1 day is 1440 minutes).\n**If blank, the punishment is indefinite**'
            }
        ],
        footer: {
            text: 'If you have any questions, get in touch with the developers.'
        },
    }

    private static HELP_EMBED: MessageEmbedOptions = {
        title: `${CONFIG.bot.prefix}punishments Walkthrough`,
        description: `There are a few commands to be aware of.

Returns this embed.
\`\`\`${CONFIG.bot.prefix}punishments help\`\`\`
Returns a single embed for each role or user that has ping protection.
\`\`\`${CONFIG.bot.prefix}punishments list\`\`\`
Returns all punishments that the selected user has received by the bot.
\`\`\`${CONFIG.bot.prefix}punishments for @user\`\`\`
Allows you to create new punishments. 
${disclaimer}
\`\`\`${CONFIG.bot.prefix}punishments (create|add) [options]\`\`\`
Allows you to remove an existing punishment. 
${disclaimer}
\`\`\`${CONFIG.bot.prefix}punishments (remove|delete) [options]\`\`\`
`,
    }
}
