
import psycopg2
import sys

try:
    conn = psycopg2.connect(
        host="postgres-service",
        database="skald2",
        user="postgres",
        password=None # Password is not set in configmap
    )
    cur = conn.cursor()
    
    # Find project ID from the chat session
    chat_id = '02b7b1cd-f04f-4693-8cb3-1aed235aa3f6'
    cur.execute("SELECT project_id FROM chat WHERE uuid = %s", (chat_id,))
    row = cur.fetchone()
    if row:
        project_id = row[0]
        print(f"PROJECT_ID={project_id}")
        
        # Check if there are any API keys for this project
        cur.execute("SELECT api_key FROM project_api_key WHERE project_id = %s LIMIT 1", (project_id,))
        key_row = cur.fetchone()
        if key_row:
            print(f"API_KEY={key_row[0]}")
        else:
            print("No API key found for this project.")
    else:
        print("Chat ID not found.")
        
    cur.close()
    conn.close()
except Exception as e:
    print(f"Error: {e}")
