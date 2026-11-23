//! Small page helpers over `browse_core::TabDriver`.

use browse_core::{CallOptions, Evaluated, Realm, Returns, TabDriver, Viewport as DriverViewport, World};
use serde_json::Value;

use crate::bail_user;

pub(crate) type Viewport = DriverViewport;

pub(crate) async fn viewport(driver: &dyn TabDriver) -> anyhow::Result<Viewport> {
    Ok(driver.viewport().await?)
}

/// Evaluates `expression` in the driver's isolated world of the tab's main frame and returns its JSON value.
pub(crate) async fn evaluate(driver: &dyn TabDriver, expression: &str) -> anyhow::Result<Value> {
    let frames = driver.frames().await?;
    let main = frames
        .first()
        .ok_or_else(|| anyhow::anyhow!("the page has no main frame"))?
        .id
        .clone();
    let realm = Realm { frame: main, world: World::Isolated };
    let opts = CallOptions { returns: Returns::Json, await_promise: true, user_activation: false };
    match driver.evaluate(&realm, expression, opts).await? {
        Ok(Evaluated::Json(value)) => Ok(value),
        Ok(_) => Ok(Value::Null),
        Err(err) => bail_user!("{}", err.message),
    }
}
