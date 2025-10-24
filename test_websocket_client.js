import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:48909');

ws.on('open', function open() {
    console.log('Connected to Mindcraft WebSocket server');
    
    // Send a ping
    ws.send(JSON.stringify({
        type: 'ping'
    }));
    
    // Wait a bit, then inject a test task
    setTimeout(() => {
        console.log('Injecting test task...');
        ws.send(JSON.stringify({
            type: 'task',
            task: 'Hello from WebSocket client!'
        }));
    }, 2000);
    
    // Inject another task after 5 seconds
    setTimeout(() => {
        console.log('Injecting command task...');
        ws.send(JSON.stringify({
            type: 'task',
            task: '!stats'
        }));
    }, 5000);
});

ws.on('message', function message(data) {
    const parsed = JSON.parse(data.toString());
    console.log('Received from server:', parsed);
    
    if (parsed.type === 'log') {
        console.log(`🤖 Agent responded: "${parsed.message}"`);
    } else if (parsed.type === 'screenshot') {
        console.log(`📸 Received screenshot (${parsed.encoding})`);
    } else if (parsed.type === 'task_finished') {
        console.log(`✅ Task finished: ${parsed.status} - ${parsed.message || ''}`);
    }
});

ws.on('close', function close() {
    console.log('Disconnected from server');
});

ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
});

// Keep the script running
process.on('SIGINT', () => {
    console.log('\nClosing WebSocket connection...');
    ws.close();
    process.exit(0);
});
