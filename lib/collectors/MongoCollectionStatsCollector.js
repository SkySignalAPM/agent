import { Meteor } from 'meteor/meteor';

/**
 * MongoCollectionStatsCollector
 *
 * Collects MongoDB collection statistics for monitoring:
 * - Document counts
 * - Collection sizes (bytes)
 * - Index counts
 * - Storage statistics
 *
 * Provides real metadata to complement trace-based query metrics.
 */
export default class MongoCollectionStatsCollector {
	constructor(options = {}) {
		this.mongoClient = options.client; // MongoDB Node.js driver client
		this.skySignalClient = options.skySignalClient;
		this.host = options.host || 'unknown';
		this.appVersion = options.appVersion || 'unknown';
		this.buildHash = options.buildHash || null;
		this.enabled = options.enabled !== false;

		// Configuration
		this.collectionInterval = options.collectionInterval || 300000; // Default: 5 minutes

		// MongoDB database reference
		this.db = null;

		// Timers
		this.collectionTimer = null;
		this.started = false;
	}

	start() {
		if (!this.enabled || this.started) {
			return;
		}

		if (!this.skySignalClient) {
			console.warn('⚠️ MongoCollectionStatsCollector: No SkySignal client provided');
			return;
		}

		if (!this.mongoClient) {
			console.warn('⚠️ MongoCollectionStatsCollector: No MongoDB client provided');
			return;
		}

		try {
			// Get MongoDB database instance from the client
			this.db = this.mongoClient.db();

			if (!this.db) {
				console.warn('⚠️ MongoCollectionStatsCollector: Cannot access MongoDB database');
				return;
			}

			// Start periodic collection
			this.collectionTimer = setInterval(() => {
				this._collectStats();
			}, this.collectionInterval);

			// Collect initial stats
			Meteor.defer(() => this._collectStats());

			this.started = true;
			console.log('📊 MongoCollectionStatsCollector started');
		} catch (error) {
			console.error('⚠️ MongoCollectionStatsCollector failed to start:', error.message);
		}
	}

	stop() {
		if (this.collectionTimer) {
			clearInterval(this.collectionTimer);
			this.collectionTimer = null;
		}
		this.started = false;
		console.log('MongoCollectionStatsCollector stopped');
	}

	/**
	 * Collect statistics for all collections
	 */
	async _collectStats() {
		if (!this.db) {
			console.warn('⚠️ MongoCollectionStatsCollector: No database available');
			return;
		}

		try {
			console.log('📊 MongoCollectionStatsCollector: Starting collection...');
			const timestamp = new Date();

			// Get list of all collections (excluding system collections)
			const collections = await this.db.listCollections({
				name: { $not: { $regex: /^system\./ } }
			}).toArray();

			console.log(`📊 MongoCollectionStatsCollector: Found ${collections.length} collections`);

			const statsPromises = collections.map(async (collInfo) => {
				try {
					return await this._getCollectionStats(collInfo.name, timestamp);
				} catch (error) {
					console.error(`⚠️ Failed to get stats for collection ${collInfo.name}:`, error.message);
					return null;
				}
			});

			const allStats = (await Promise.all(statsPromises)).filter(stat => stat !== null);

			console.log(`📊 MongoCollectionStatsCollector: Collected stats for ${allStats.length} collections`);

			// Send to SkySignal
			if (allStats.length > 0) {
				this.skySignalClient.addCollectionStats({
					timestamp,
					host: this.host,
					appVersion: this.appVersion,
					buildHash: this.buildHash,
					collections: allStats
				});
				console.log('✅ MongoCollectionStatsCollector: Stats sent to SkySignal');
			} else {
				console.warn('⚠️ MongoCollectionStatsCollector: No stats to send');
			}
		} catch (error) {
			console.error('⚠️ MongoCollectionStatsCollector error:', error.message);
			console.error(error.stack);
		}
	}

	/**
	 * Get statistics for a single collection
	 * Uses db.command() as collection.stats() was removed in MongoDB Driver 6.x (Meteor 3.x)
	 */
	async _getCollectionStats(collectionName, timestamp) {
		try {
			const collection = this.db.collection(collectionName);

			// Get collection stats using command (collection.stats() removed in Driver 6.x)
			const stats = await this.db.command({ collStats: collectionName });

			// Get index information
			const indexes = await collection.listIndexes().toArray();

			return {
				name: collectionName,
				documentCount: stats.count || 0,
				size: stats.size || 0, // bytes
				storageSize: stats.storageSize || 0, // bytes (includes padding)
				indexCount: stats.nindexes || indexes.length || 0,
				totalIndexSize: stats.totalIndexSize || 0, // bytes
				avgObjSize: stats.avgObjSize || 0, // bytes
				indexes: indexes.map(idx => ({
					name: idx.name,
					keys: idx.key,
					size: idx.size || 0 // Not always available
				}))
			};
		} catch (error) {
			// Some collections may not support stats (e.g., views)
			if (error.codeName === 'CommandNotSupportedOnView') {
				return null;
			}
			throw error;
		}
	}
}
