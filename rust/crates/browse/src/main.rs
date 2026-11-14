fn main() {
    let tools: Vec<_> = [browse_relay::tools(), browse_page::tools(), browse_capture::tools()].concat();
    println!("browse (rust): {} tools", tools.len());
}
