const logger = require('@greencoast/logger');
const Queue = require('./Queue');
const DataFolderManager = require('./DataFolderManager');
const ProviderFactory = require('./providers/ProviderFactory');
const MissingArgumentError = require('./errors/MissingArgumentError');
const VoiceChannelError = require('./errors/VoiceChannelError');

class Player {
  constructor(client) {
    this.client = client;

    this.dataFolderManager = new DataFolderManager();
    this.queue = new Queue(this.dataFolderManager, {
      shuffle: client.config.get('SHUFFLE')
    });
    this.providerFactory = new ProviderFactory({
      youtubeCookie: client.config.get('YOUTUBE_COOKIE'),
      soundcloudClientID: client.config.get('SOUNDCLOUD_CLIENT_ID')
    });

    this.channel = null;
    this.connection = null;
    this.dispatcher = null;
    this.stream = null;

    this.currentSong = null;
    this.listeners = 0;

    this.pauseOnEmpty = client.config.get('PAUSE_ON_EMPTY');
  }

  async initialize(channelID) {
    if (!channelID) {
      throw new MissingArgumentError('channelID is required in bot config!');
    }

    await this.client.presenceManager.update('◼ Nothing to play');

    try {
      const channel = await this.client.channels.fetch(channelID);

      if (!channel.joinable) {
        throw new VoiceChannelError("I don't have enough permissions to join the configured voice channel!");
      }

      return this.updateChannel(channel);
    } catch (error) {
      if (error instanceof VoiceChannelError) {
        throw error;
      }
      
      if (error === 'DiscordAPIError: Unknown Channel') {
        throw new VoiceChannelError('The channel I tried to join does not exist. Please check the channelID set up in your bot config.');
      }

      throw new VoiceChannelError('Something went wrong when trying to look for the channel I was supposed to join.');
    }
  }

  async updateChannel(channel) {
    logger.info(`Joined ${channel.name} in ${channel.guild.name}.`);
    this.channel = channel;

    if (!this.connection) {
      this.connection = await channel.join();
      this.updateListeners();

      if (!this.dispatcher) {
        this.play();
      }
    }
  }

  async play() {
    if (!this.connection) {
      return;
    }

    const url = this.queue.getNext();
    const provider = this.providerFactory.getInstance(url);

    this.stream = await provider.createStream(url);

    // If a provider encounters an error, stream will be null.
    if (!this.stream) {
      this.play();
    }

    this.dispatcher = this.connection.play(this.stream);
    this.currentSong = this.stream.info;

    this.updateDispatcherStatus();

    this.dispatcher.on('start', () => {
      logger.info(`Playing (${this.currentSong.source}): ${this.currentSong.title} for ${this.listeners} user(s) in ${this.channel.name}.`);
    });

    this.dispatcher.on('finish', () => {
      this.play();
    });

    this.dispatcher.on('error', (error) => {
      logger.error(error);
      this.play();
    });

    if (this.client.debug) {
      this.dispatcher.on('debug', (info) => {
        logger.debug(info);
      });
    }
  }

  skipCurrentSong(reason) {
    this.stream.destroy();
    logger.info(reason || `(${this.currentSong.source}): ${this.currentSong.title} has been skipped.`);
    this.play();
  }

  updateListeners() {
    this.listeners = this.channel.members.reduce((sum) => sum + 1, 0) - 1; // Self does not count.
  }

  updatePresenceWithSong() {
    const icon = this.dispatcher.paused ? '❙ ❙' : '►';
    return this.client.presenceManager.update(`${icon} ${this.currentSong.title}`);
  }

  updateDispatcherStatus() {
    if (!this.dispatcher) {
      return null;
    }

    if (this.listeners > 0) {
      return this.resumeDispatcher();
    }

    return this.pauseDispatcher();
  }

  resumeDispatcher() {
    if (!this.dispatcher.paused) {
      return;
    }

    if (this.isStreamExpired()) {
      this.skipCurrentSong('Stream has expired, skipping...');
      return;
    }

    this.dispatcher.resume();
    logger.info('Music has been resumed.');
    this.updatePresenceWithSong();
  }

  pauseDispatcher() {
    if (this.dispatcher.paused || !this.pauseOnEmpty) {
      return;
    }

    this.dispatcher.pause();
    logger.info('Music has been paused because nobody is in my channel.');
    this.updatePresenceWithSong();
  }

  isStreamExpired() {
    if (!this.dispatcher) {
      return false;
    }

    return this.dispatcher.pausedTime > Player.STREAM_MAX_AGE;
  }
}

Player.STREAM_MAX_AGE = 7200000; // TWO HOURS

module.exports = Player;
