#!/bin/bash

# Define port
PORT=8080

# Check if a python server is already running on this port and start it if not
if ! nc -z localhost $PORT; then
    echo "🚀 Starting local HTTP server on port $PORT..."
    python3 -m http.server $PORT &
    sleep 1
else
    echo "✅ Local server is already running on port $PORT."
fi

echo "🌐 Opening viewer in Google Chrome..."
google-chrome "http://localhost:$PORT/viewer.html"

echo "🎯 Done! Remember, you can just refresh the Chrome tab (F5) whenever you change the .mmd file in VSCode."
