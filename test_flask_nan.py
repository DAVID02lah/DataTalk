from flask import Flask, jsonify
app = Flask(__name__)
with app.app_context():
    try:
        res = jsonify({"value": float('nan')})
        print("Success:", res.get_data(as_text=True))
    except Exception as e:
        print("Exception:", type(e), e)
