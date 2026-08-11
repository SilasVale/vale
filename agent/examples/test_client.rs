use rmcp::{ServiceExt, transport::{
    StreamableHttpClientTransport,
    streamable_http_client::StreamableHttpClientTransportConfig,
}};

#[tokio::main]
async fn main() {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri("http://172.16.0.177:3000/mcp"),
    );

    println!("Connecting...");
    let client = match ().serve(transport).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to connect: {e}");
            println!("Press Enter to exit...");
            let _ = std::io::stdin().read_line(&mut String::new());
            return;
        }
    };

    let tools = client.list_tools(None).await.unwrap();
    println!("Connected! {} tools:", tools.tools.len());
    for t in &tools.tools {
        println!("  - {}", t.name);
    }

    let _ = client.cancel().await;
    println!("Press Enter to exit...");
    let _ = std::io::stdin().read_line(&mut String::new());
}
