// Performance monitoring utility for diagnosing connection issues

class PerformanceMonitor {
    constructor(agentName) {
        this.agentName = agentName;
        this.metrics = {
            statePushCount: 0,
            statePushErrors: 0,
            lastPushDuration: 0,
            maxPushDuration: 0,
            avgPushDuration: 0,
            pushDurations: []
        };
        this.slowThreshold = 100; // Log if push takes > 100ms
        this.enabled = process.env.MONITOR_PERFORMANCE === 'true';
    }

    startTiming() {
        return Date.now();
    }

    endTiming(startTime, operation = 'state-push') {
        const duration = Date.now() - startTime;
        
        if (operation === 'state-push') {
            this.metrics.statePushCount++;
            this.metrics.lastPushDuration = duration;
            
            // Track durations for average calculation
            this.metrics.pushDurations.push(duration);
            if (this.metrics.pushDurations.length > 100) {
                this.metrics.pushDurations.shift(); // Keep only last 100
            }
            
            // Update max
            if (duration > this.metrics.maxPushDuration) {
                this.metrics.maxPushDuration = duration;
            }
            
            // Update average
            this.metrics.avgPushDuration = 
                this.metrics.pushDurations.reduce((a, b) => a + b, 0) / this.metrics.pushDurations.length;
            
            // Log slow operations
            if (duration > this.slowThreshold && this.enabled) {
                console.warn(`⚠️ [${this.agentName}] Slow ${operation}: ${duration}ms`);
            }
        }
        
        return duration;
    }

    recordError(operation = 'state-push') {
        if (operation === 'state-push') {
            this.metrics.statePushErrors++;
        }
    }

    getMetrics() {
        return {
            ...this.metrics,
            errorRate: this.metrics.statePushCount > 0 
                ? (this.metrics.statePushErrors / this.metrics.statePushCount * 100).toFixed(2) + '%'
                : '0%'
        };
    }

    printReport() {
        if (!this.enabled) return;
        
        const metrics = this.getMetrics();
        console.log(`\n📊 [${this.agentName}] Performance Report:`);
        console.log(`   State Pushes: ${metrics.statePushCount}`);
        console.log(`   Errors: ${metrics.statePushErrors} (${metrics.errorRate})`);
        console.log(`   Last Push: ${metrics.lastPushDuration}ms`);
        console.log(`   Avg Push: ${metrics.avgPushDuration.toFixed(2)}ms`);
        console.log(`   Max Push: ${metrics.maxPushDuration}ms`);
        console.log(`========================================\n`);
    }

    reset() {
        this.metrics = {
            statePushCount: 0,
            statePushErrors: 0,
            lastPushDuration: 0,
            maxPushDuration: 0,
            avgPushDuration: 0,
            pushDurations: []
        };
    }
}

export default PerformanceMonitor;

