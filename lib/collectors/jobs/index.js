/**
 * Job Monitoring Module
 *
 * Provides extensible job monitoring for various Meteor job queue packages.
 *
 * Currently supported packages:
 * - msavin:sjobs (Steve Jobs)
 *
 * To add support for a new package:
 * 1. Create a new class extending BaseJobMonitor
 * 2. Implement all abstract methods
 * 3. Register the adapter in JobCollector.ADAPTERS
 */

import BaseJobMonitor from "./BaseJobMonitor.js";
import SteveJobsMonitor from "./SteveJobsMonitor.js";

/**
 * JobCollector
 * Factory class that auto-detects and initializes the appropriate job monitor
 */
export class JobCollector {
	/**
	 * Map of package names to their adapter classes
	 * Add new adapters here
	 */
	static ADAPTERS = {
		"msavin:sjobs": SteveJobsMonitor
		// Future adapters:
		// "littledata:synced-cron": SyncedCronMonitor,
		// "wildhart:jobs": WildhartJobsMonitor,
		// "percolate:synced-cron": PercolateCronMonitor,
	};

	/**
	 * Create a job collector with auto-detection
	 *
	 * @param {Object} options - Configuration options
	 * @param {Object} options.client - SkySignalClient instance
	 * @param {String} [options.host] - Host identifier
	 * @param {Number} [options.interval] - Stats collection interval (ms)
	 * @param {String} [options.preferredPackage] - Force a specific package adapter
	 * @returns {BaseJobMonitor|null} - Job monitor instance or null if no package found
	 */
	static create(options = {}) {
		// If user specified a preferred package, try that first
		if (options.preferredPackage && this.ADAPTERS[options.preferredPackage]) {
			const AdapterClass = this.ADAPTERS[options.preferredPackage];
			const adapter = new AdapterClass(options);

			if (adapter.isPackageAvailable()) {
				console.log(`✅ Using job monitor for: ${options.preferredPackage}`);
				return adapter;
			} else {
				console.warn(`⚠️ Preferred package ${options.preferredPackage} not available`);
			}
		}

		// Auto-detect available job package
		for (const [packageName, AdapterClass] of Object.entries(this.ADAPTERS)) {
			try {
				const adapter = new AdapterClass(options);

				if (adapter.isPackageAvailable()) {
					console.log(`✅ Auto-detected job package: ${packageName}`);
					return adapter;
				}
			} catch (e) {
				// Package not available, continue checking
			}
		}

		console.log("ℹ️  No supported job queue package detected - job monitoring disabled");
		return null;
	}

	/**
	 * Get list of supported packages
	 * @returns {Array<String>}
	 */
	static getSupportedPackages() {
		return Object.keys(this.ADAPTERS);
	}

	/**
	 * Register a custom adapter
	 *
	 * @param {String} packageName - Name of the job package
	 * @param {Class} adapterClass - Adapter class extending BaseJobMonitor
	 */
	static registerAdapter(packageName, adapterClass) {
		if (!(adapterClass.prototype instanceof BaseJobMonitor)) {
			throw new Error("Adapter must extend BaseJobMonitor");
		}

		this.ADAPTERS[packageName] = adapterClass;
		console.log(`✅ Registered custom job adapter for: ${packageName}`);
	}
}

// Export individual classes for advanced usage
export { BaseJobMonitor, SteveJobsMonitor };

// Default export is the factory
export default JobCollector;
