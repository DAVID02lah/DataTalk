import requests
import json
import uuid

# Dummy auth token if needed, or we just bypass by mocking.
# Wait, we need an active file.
print("Connecting...")
res = requests.post("http://127.0.0.1:5000/api/dashboard/card-data", headers={"Content-Type": "application/json", "Authorization": "Bearer TEST_TOKEN"}, json={"column": "Test", "aggregation": "sum"})
print("Status:", res.status_code)
print("Response text:", res.text)
