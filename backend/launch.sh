#!/bin/bash
# Chatbot Launch Script for Mac/Linux
# This script automatically installs dependencies if needed and starts the server

# Configuration
URL="http://localhost:15101/chatbot"
MAX_RETRIES=60

echo "Starting Chatbot Server..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Please install Node.js and try again."
    exit 1
fi

# Change to script directory
cd "$(dirname "$0")"

# Check dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "Failed to install dependencies. Please check your npm installation."
        exit 1
    fi
    echo "Dependencies installed successfully."
fi

# Start the server in background
echo "Starting server on $URL"
node server.js &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server to start..."
retries=$MAX_RETRIES
while [ $retries -gt 0 ]; do
    if curl -fsS "$URL" > /dev/null 2>&1; then
        echo "Server is ready!"
        break
    fi
    sleep 1
    retries=$((retries - 1))
done

# Open browser (try different commands for different systems)
if command -v open &> /dev/null; then
    # macOS
    open "$URL"
elif command -v xdg-open &> /dev/null; then
    # Linux
    xdg-open "$URL"
else
    echo "Please open your browser and navigate to: $URL"
fi

# Wait for server process
wait $SERVER_PID